use std::{ffi::c_void, fmt};

use wgpu::hal::api;
use windows::Win32::{
    Foundation::{HANDLE, LUID},
    Graphics::{
        Direct3D12::ID3D12Resource,
        Dxgi::{CreateDXGIFactory1, IDXGIFactory2},
    },
};

/// Stable platform boundary for importing callback-scoped CEF GPU frames.
///
/// CEF exposes a D3D shared handle on Windows, an IOSurface on macOS, and
/// dma-buf planes on Linux. Only the Windows implementation is enabled in this
/// prototype; future platform implementations belong behind this trait rather
/// than in the compositor itself.
pub(super) trait TextureImporter: Sized {
    type AdapterId: Copy + Eq + fmt::Debug + fmt::Display + Send + Sync + 'static;

    const PLATFORM: &'static str;

    fn new(selected_adapter: Self::AdapterId) -> Result<Self, String>;

    fn adapter_id_from_shared_handle(handle: *mut c_void) -> Result<Self::AdapterId, String>;

    fn adapter_id_from_wgpu_adapter(adapter: &wgpu::Adapter) -> Result<Self::AdapterId, String>;

    fn import_texture(
        &self,
        device: &wgpu::Device,
        handle: *mut c_void,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
    ) -> Result<ImportedTexture, TextureImportError<Self::AdapterId>>;
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct AdapterLuid {
    low: u32,
    high: i32,
}

impl AdapterLuid {
    fn from_windows(value: LUID) -> Self {
        Self {
            low: value.LowPart,
            high: value.HighPart,
        }
    }

    pub(super) fn as_u64(self) -> u64 {
        (u64::from(self.high as u32) << 32) | u64::from(self.low)
    }
}

impl fmt::Display for AdapterLuid {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:016x}", self.as_u64())
    }
}

pub(super) struct ImportedTexture {
    pub(super) texture: wgpu::Texture,
    pub(super) source_adapter_luid: AdapterLuid,
}

#[derive(Debug)]
pub(super) enum TextureImportError<AdapterId> {
    AdapterMismatch {
        selected: AdapterId,
        source: AdapterId,
    },
    Import(String),
}

impl<AdapterId: fmt::Display> fmt::Display for TextureImportError<AdapterId> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AdapterMismatch { selected, source } => write!(
                formatter,
                "CEF shared texture adapter {source} does not match selected adapter {selected}"
            ),
            Self::Import(message) => formatter.write_str(message),
        }
    }
}

pub(super) struct WindowsDx12TextureImporter {
    factory: IDXGIFactory2,
    selected_adapter_luid: AdapterLuid,
}

impl WindowsDx12TextureImporter {
    fn shared_handle_adapter_luid(
        factory: &IDXGIFactory2,
        handle: *mut c_void,
    ) -> Result<AdapterLuid, String> {
        if handle.is_null() {
            return Err("CEF returned a null D3D shared texture handle".to_string());
        }
        let luid = unsafe { factory.GetSharedResourceAdapterLuid(HANDLE(handle)) }
            .map_err(|error| format!("DXGI GetSharedResourceAdapterLuid failed: {error}"))?;
        Ok(AdapterLuid::from_windows(luid))
    }
}

impl TextureImporter for WindowsDx12TextureImporter {
    type AdapterId = AdapterLuid;

    const PLATFORM: &'static str = "windows-dx12-shared-handle";

    fn new(selected_adapter_luid: Self::AdapterId) -> Result<Self, String> {
        let factory: IDXGIFactory2 = unsafe { CreateDXGIFactory1() }
            .map_err(|error| format!("failed to create DXGI factory: {error}"))?;
        Ok(Self {
            factory,
            selected_adapter_luid,
        })
    }

    fn adapter_id_from_shared_handle(handle: *mut c_void) -> Result<Self::AdapterId, String> {
        let factory: IDXGIFactory2 = unsafe { CreateDXGIFactory1() }
            .map_err(|error| format!("failed to create DXGI factory: {error}"))?;
        Self::shared_handle_adapter_luid(&factory, handle)
    }

    fn adapter_id_from_wgpu_adapter(adapter: &wgpu::Adapter) -> Result<Self::AdapterId, String> {
        let hal_adapter = unsafe { adapter.as_hal::<api::Dx12>() }
            .ok_or_else(|| "wgpu adapter is not using the DX12 backend".to_string())?;
        let descriptor = unsafe { hal_adapter.raw_adapter().GetDesc2() }
            .map_err(|error| format!("failed to inspect DX12 adapter: {error}"))?;
        Ok(AdapterLuid::from_windows(descriptor.AdapterLuid))
    }

    fn import_texture(
        &self,
        device: &wgpu::Device,
        handle: *mut c_void,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
    ) -> Result<ImportedTexture, TextureImportError<Self::AdapterId>> {
        let source_adapter_luid = Self::shared_handle_adapter_luid(&self.factory, handle)
            .map_err(TextureImportError::Import)?;
        if source_adapter_luid != self.selected_adapter_luid {
            return Err(TextureImportError::AdapterMismatch {
                selected: self.selected_adapter_luid,
                source: source_adapter_luid,
            });
        }

        // Adapter validation must happen before OpenSharedHandle. CEF may
        // recreate its GPU process and start producing handles from another
        // adapter while the browser session remains alive.
        let hal_texture = unsafe {
            let hal_device = device.as_hal::<api::Dx12>().ok_or_else(|| {
                TextureImportError::Import("wgpu device is not using the DX12 backend".to_string())
            })?;
            let mut resource: Option<ID3D12Resource> = None;
            hal_device
                .raw_device()
                .OpenSharedHandle(HANDLE(handle), &mut resource)
                .map_err(|error| {
                    TextureImportError::Import(format!("D3D12 OpenSharedHandle failed: {error}"))
                })?;
            let resource = resource.ok_or_else(|| {
                TextureImportError::Import("D3D12 did not return a shared resource".to_string())
            })?;
            <api::Dx12 as wgpu::hal::Api>::Device::texture_from_raw(
                resource,
                format,
                wgpu::TextureDimension::D2,
                wgpu::Extent3d {
                    width,
                    height,
                    depth_or_array_layers: 1,
                },
                1,
                1,
            )
        };
        let texture = unsafe {
            device.create_texture_from_hal::<api::Dx12>(
                hal_texture,
                &wgpu::TextureDescriptor {
                    label: Some("Ardor imported CEF D3D texture"),
                    size: wgpu::Extent3d {
                        width,
                        height,
                        depth_or_array_layers: 1,
                    },
                    mip_level_count: 1,
                    sample_count: 1,
                    dimension: wgpu::TextureDimension::D2,
                    format,
                    usage: wgpu::TextureUsages::TEXTURE_BINDING,
                    view_formats: &[],
                },
            )
        };
        Ok(ImportedTexture {
            texture,
            source_adapter_luid,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adapter_luid_has_stable_fixed_width_format() {
        let luid = AdapterLuid {
            low: 0x89ab_cdef,
            high: 0x0123_4567,
        };
        assert_eq!(luid.to_string(), "0123456789abcdef");
    }
}
