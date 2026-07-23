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

#[cfg(test)]
mod tests {
    use super::*;

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
}
