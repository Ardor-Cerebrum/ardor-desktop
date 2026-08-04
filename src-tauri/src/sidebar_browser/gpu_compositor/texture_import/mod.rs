use std::{ffi::c_void, fmt};

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub(super) use windows::{AdapterLuid, WindowsDx12TextureImporter};
#[cfg(windows)]
pub(super) type PlatformTextureImporter = windows::WindowsDx12TextureImporter;

#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub(super) use macos::MacosMetalTextureImporter;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
pub(super) type PlatformTextureImporter = MacosMetalTextureImporter;

pub(super) trait TextureImporter: Sized + Send {
    type AdapterId: Copy + Eq + fmt::Debug + fmt::Display + Send + Sync + 'static;

    const PLATFORM: &'static str;

    fn adapter_hint_from_shared_handle(
        handle: *mut c_void,
    ) -> Result<Option<Self::AdapterId>, String>;

    fn adapter_id_from_wgpu_adapter(adapter: &wgpu::Adapter) -> Result<Self::AdapterId, String>;

    fn new(selected_adapter: Self::AdapterId) -> Result<Self, String>;

    fn import_texture(
        &self,
        device: &wgpu::Device,
        handle: *mut c_void,
        format: wgpu::TextureFormat,
        width: u32,
        height: u32,
    ) -> Result<ImportedTexture<Self::AdapterId>, TextureImportError<Self::AdapterId>>;
}

pub(super) struct ImportedTexture<AdapterId> {
    pub(super) texture: wgpu::Texture,
    pub(super) source_adapter_id: Option<AdapterId>,
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
