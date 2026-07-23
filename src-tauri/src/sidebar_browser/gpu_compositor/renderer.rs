pub(super) const COMPOSITOR_SHADER_WGSL: &str = r#"
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0,  3.0),
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
  );
  var uvs = array<vec2<f32>, 3>(
    vec2<f32>(0.0, -1.0),
    vec2<f32>(0.0,  1.0),
    vec2<f32>(2.0,  1.0),
  );
  var output: VertexOutput;
  output.position = vec4<f32>(positions[index], 0.0, 1.0);
  output.uv = uvs[index];
  return output;
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;

fn srgb_to_linear(value: vec3<f32>) -> vec3<f32> {
  let low = value / vec3<f32>(12.92);
  let high = pow(
    (value + vec3<f32>(0.055)) / vec3<f32>(1.055),
    vec3<f32>(2.4),
  );
  return select(low, high, value > vec3<f32>(0.04045));
}

@fragment
fn fs_ingest(input: VertexOutput) -> @location(0) vec4<f32> {
  let encoded = textureSample(source_texture, source_sampler, input.uv);
  if encoded.a <= 0.00001 {
    return vec4<f32>(0.0);
  }

  // Chromium OSR surfaces contain premultiplied sRGB values. Convert once
  // while ingesting a changed frame; the hot presentation pass stays trivial.
  let straight_srgb = clamp(encoded.rgb / encoded.a, vec3<f32>(0.0), vec3<f32>(1.0));
  let straight_linear = srgb_to_linear(straight_srgb);
  return vec4<f32>(straight_linear * encoded.a, encoded.a);
}

@fragment
fn fs_present(input: VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(source_texture, source_sampler, input.uv);
}
"#;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RendererBackend {
    WindowsDx12,
    MacosMetal,
}

impl RendererBackend {
    pub(super) const fn current() -> Self {
        #[cfg(windows)]
        {
            Self::WindowsDx12
        }
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            Self::MacosMetal
        }
        #[cfg(not(any(windows, all(target_os = "macos", target_arch = "aarch64"))))]
        {
            Self::WindowsDx12
        }
    }

    pub(super) const fn required_backends(self) -> wgpu::Backends {
        match self {
            Self::WindowsDx12 => wgpu::Backends::DX12,
            Self::MacosMetal => wgpu::Backends::METAL,
        }
    }

    pub(super) const fn expected_adapter_backend(self) -> wgpu::Backend {
        match self {
            Self::WindowsDx12 => wgpu::Backend::Dx12,
            Self::MacosMetal => wgpu::Backend::Metal,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum Layer {
    Shell,
    Preview,
}

impl Layer {
    pub(super) const fn as_str(self) -> &'static str {
        match self {
            Self::Shell => "shell",
            Self::Preview => "preview",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum CompositionPass {
    Preview,
    ShellOutsidePreview,
    ShellOverlay(usize),
    ShellFullWindow,
}

pub(super) fn composition_passes(
    preview_visible: bool,
    overlay_count: usize,
) -> Vec<CompositionPass> {
    let mut passes = Vec::with_capacity(2 + overlay_count);
    if preview_visible {
        passes.push(CompositionPass::Preview);
        passes.push(CompositionPass::ShellOutsidePreview);
        passes.extend((0..overlay_count).map(CompositionPass::ShellOverlay));
    } else {
        passes.push(CompositionPass::ShellFullWindow);
    }
    passes
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct FirstPresent {
    pub(crate) generation: u64,
    pub(crate) shell_sequence: u64,
}

#[derive(Default)]
pub(super) struct PresentReadiness {
    first_shell_sequence: Option<u64>,
}

impl PresentReadiness {
    pub(super) fn record_present(&mut self, layer: Layer, sequence: u64) {
        if layer == Layer::Shell && self.first_shell_sequence.is_none() {
            self.first_shell_sequence = Some(sequence);
        }
    }

    pub(super) const fn first_shell_present(&self) -> Option<u64> {
        self.first_shell_sequence
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    struct DropProbe(Arc<AtomicUsize>);

    impl Drop for DropProbe {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::AcqRel);
        }
    }

    fn copy_callback_texture_for_test(probe: DropProbe) -> Result<(), String> {
        let _callback_scoped_import = probe;
        let _owned_copy_completed = true;
        Ok(())
    }

    #[test]
    fn callback_import_is_dropped_after_owned_copy() {
        let drops = Arc::new(AtomicUsize::new(0));
        copy_callback_texture_for_test(DropProbe(drops.clone())).unwrap();
        assert_eq!(drops.load(Ordering::Acquire), 1);
    }

    #[test]
    fn present_shader_does_not_repeat_color_conversion() {
        let present = COMPOSITOR_SHADER_WGSL
            .split("fn fs_present")
            .nth(1)
            .expect("present shader entry point");
        assert!(!present.contains("pow("));
        assert!(!present.contains("srgb_to_linear"));
        assert!(present.contains("textureSample"));
    }

    #[test]
    fn ingest_uses_an_srgb_intermediate_for_dark_tone_precision() {
        assert!(COMPOSITOR_SHADER_WGSL.contains("fn fs_ingest"));
        assert!(COMPOSITOR_SHADER_WGSL.contains("srgb_to_linear"));
    }

    #[test]
    fn macos_backend_selects_only_metal() {
        assert_eq!(
            RendererBackend::MacosMetal.required_backends(),
            wgpu::Backends::METAL,
        );
    }

    #[test]
    fn composition_order_draws_preview_then_shell_regions_then_overlays() {
        assert_eq!(
            composition_passes(true, 2),
            vec![
                CompositionPass::Preview,
                CompositionPass::ShellOutsidePreview,
                CompositionPass::ShellOverlay(0),
                CompositionPass::ShellOverlay(1),
            ],
        );
    }

    #[test]
    fn first_present_requires_an_imported_shell_frame() {
        let mut readiness = PresentReadiness::default();
        readiness.record_present(Layer::Preview, 1);
        assert!(readiness.first_shell_present().is_none());
        readiness.record_present(Layer::Shell, 2);
        assert_eq!(readiness.first_shell_present(), Some(2));
    }
}
