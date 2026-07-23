use super::{ImportedTexture, TextureImportError, TextureImporter};
use objc2_core_foundation::CFRetained;
use objc2_io_surface::IOSurfaceRef;
use objc2_metal::{
    MTLCreateSystemDefaultDevice, MTLDevice as _, MTLPixelFormat, MTLTextureDescriptor,
    MTLTextureType, MTLTextureUsage,
};
use std::{ffi::c_void, fmt, ptr::NonNull};
use wgpu::hal::api;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct MetalRegistryId(pub(super) u64);

impl fmt::Display for MetalRegistryId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:016x}", self.0)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct IOSurfaceMetadata {
    plane: usize,
    format: wgpu::TextureFormat,
    width: u32,
    height: u32,
}

fn validate_iosurface_metadata(
    surface_width: usize,
    surface_height: usize,
    plane_count: usize,
    pixel_format: u32,
    cef_width: u32,
    cef_height: u32,
) -> Result<IOSurfaceMetadata, String> {
    if cef_width == 0 || cef_height == 0 {
        return Err("CEF IOSurface dimensions must be non-zero".into());
    }
    if surface_width != cef_width as usize || surface_height != cef_height as usize {
        return Err(format!(
            "CEF IOSurface dimensions {surface_width}x{surface_height} do not match callback {cef_width}x{cef_height}"
        ));
    }
    if plane_count > 1 {
        return Err(format!(
            "CEF IOSurface has unsupported plane count {plane_count}"
        ));
    }
    if pixel_format != u32::from_be_bytes(*b"BGRA") {
        return Err(format!(
            "CEF IOSurface has unsupported pixel format {pixel_format:#010x}"
        ));
    }
    Ok(IOSurfaceMetadata {
        plane: 0,
        format: wgpu::TextureFormat::Bgra8Unorm,
        width: cef_width,
        height: cef_height,
    })
}

fn verify_registry_id(
    selected: MetalRegistryId,
    source: MetalRegistryId,
) -> Result<(), TextureImportError<MetalRegistryId>> {
    if selected == source {
        Ok(())
    } else {
        Err(TextureImportError::AdapterMismatch { selected, source })
    }
}

pub(crate) struct MacosMetalTextureImporter {
    selected_adapter: MetalRegistryId,
}

impl TextureImporter for MacosMetalTextureImporter {
    type AdapterId = MetalRegistryId;

    const PLATFORM: &'static str = "macos-metal-iosurface";

    fn adapter_hint_from_shared_handle(
        _handle: *mut c_void,
    ) -> Result<Option<Self::AdapterId>, String> {
        Ok(None)
    }

    fn adapter_id_from_wgpu_adapter(adapter: &wgpu::Adapter) -> Result<Self::AdapterId, String> {
        if adapter.get_info().backend != wgpu::Backend::Metal {
            return Err("wgpu adapter is not using the Metal backend".to_string());
        }
        let device = MTLCreateSystemDefaultDevice()
            .ok_or_else(|| "Metal did not expose a system default device".to_string())?;
        Ok(MetalRegistryId(device.registryID()))
    }

    fn new(selected_adapter: Self::AdapterId) -> Result<Self, String> {
        Ok(Self { selected_adapter })
    }

    fn import_texture(
        &self,
        device: &wgpu::Device,
        handle: *mut c_void,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
    ) -> Result<ImportedTexture<Self::AdapterId>, TextureImportError<Self::AdapterId>> {
        if format != wgpu::TextureFormat::Bgra8Unorm {
            return Err(TextureImportError::Import(format!(
                "CEF IOSurface callback has unsupported WGPU format {format:?}"
            )));
        }

        let surface_ptr = NonNull::new(handle.cast::<IOSurfaceRef>())
            .ok_or_else(|| TextureImportError::Import("CEF returned a null IOSurface".into()))?;

        // SAFETY: CEF owns the callback-scoped IOSurface reference. Retaining it
        // here gives this import scope an independent +1 that is released after
        // the Metal texture has been wrapped by WGPU.
        let surface = unsafe { CFRetained::retain(surface_ptr) };
        let metadata = validate_iosurface_metadata(
            surface.width(),
            surface.height(),
            surface.plane_count(),
            surface.pixel_format(),
            width,
            height,
        )
        .map_err(TextureImportError::Import)?;

        // SAFETY: The WGPU device is required to be the selected Metal device,
        // the IOSurface metadata is validated against CEF's callback, and the
        // imported texture descriptor exactly matches that storage.
        let texture = unsafe {
            let hal_device = device.as_hal::<api::Metal>().ok_or_else(|| {
                TextureImportError::Import("wgpu device is not using Metal".into())
            })?;
            let raw_device = hal_device.raw_device();
            verify_registry_id(
                self.selected_adapter,
                MetalRegistryId(raw_device.registryID()),
            )?;

            let descriptor =
                MTLTextureDescriptor::texture2DDescriptorWithPixelFormat_width_height_mipmapped(
                    MTLPixelFormat::BGRA8Unorm,
                    metadata.width as usize,
                    metadata.height as usize,
                    false,
                );
            descriptor.setUsage(MTLTextureUsage::ShaderRead);
            let metal_texture = raw_device
                .newTextureWithDescriptor_iosurface_plane(&descriptor, &surface, metadata.plane)
                .ok_or_else(|| {
                    TextureImportError::Import("Metal rejected the CEF IOSurface".into())
                })?;

            let hal_texture = <api::Metal as wgpu::hal::Api>::Device::texture_from_raw(
                metal_texture,
                metadata.format,
                MTLTextureType::Type2D,
                1,
                1,
                wgpu::hal::CopyExtent {
                    width: metadata.width,
                    height: metadata.height,
                    depth: 1,
                },
            );
            device.create_texture_from_hal::<api::Metal>(
                hal_texture,
                &wgpu::TextureDescriptor {
                    label: Some("Ardor imported CEF IOSurface texture"),
                    size: wgpu::Extent3d {
                        width: metadata.width,
                        height: metadata.height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format: metadata.format,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                },
            )
        };

        Ok(ImportedTexture {
            texture,
            source_adapter_id: Some(self.selected_adapter),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iosurface_metadata_accepts_single_plane_bgra() {
        let metadata =
            validate_iosurface_metadata(1280, 720, 0, u32::from_be_bytes(*b"BGRA"), 1280, 720)
                .expect("BGRA IOSurface should be valid");
        assert_eq!(metadata.plane, 0);
        assert_eq!(metadata.format, wgpu::TextureFormat::Bgra8Unorm);
    }

    #[test]
    fn iosurface_metadata_rejects_mismatched_dimensions_and_formats() {
        assert!(
            validate_iosurface_metadata(640, 480, 0, u32::from_be_bytes(*b"BGRA"), 1280, 720,)
                .is_err()
        );
        assert!(validate_iosurface_metadata(640, 480, 2, 0, 640, 480).is_err());
    }

    #[test]
    fn metal_registry_ids_must_match() {
        assert!(verify_registry_id(MetalRegistryId(7), MetalRegistryId(7)).is_ok());
        assert!(matches!(
            verify_registry_id(MetalRegistryId(7), MetalRegistryId(8)),
            Err(TextureImportError::AdapterMismatch { .. })
        ));
    }
}
