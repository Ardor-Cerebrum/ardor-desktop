use super::super::BrowserBounds;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(super) struct LogicalRect {
    pub(super) x: f64,
    pub(super) y: f64,
    pub(super) width: f64,
    pub(super) height: f64,
}

impl LogicalRect {
    pub(super) const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub(super) fn contains(self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }

    pub(super) fn to_physical(self, scale: f64) -> PhysicalRect {
        PhysicalRect {
            x: (self.x * scale).round().max(0.0) as u32,
            y: (self.y * scale).round().max(0.0) as u32,
            width: (self.width * scale).round().max(0.0) as u32,
            height: (self.height * scale).round().max(0.0) as u32,
        }
    }
}

impl From<BrowserBounds> for LogicalRect {
    fn from(bounds: BrowserBounds) -> Self {
        Self::new(bounds.x, bounds.y, bounds.width, bounds.height)
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct PhysicalRect {
    pub(super) x: u32,
    pub(super) y: u32,
    pub(super) width: u32,
    pub(super) height: u32,
}

pub(super) fn clamp_rect(rect: PhysicalRect, width: u32, height: u32) -> PhysicalRect {
    let x = rect.x.min(width);
    let y = rect.y.min(height);
    PhysicalRect {
        x,
        y,
        width: rect.width.min(width.saturating_sub(x)),
        height: rect.height.min(height.saturating_sub(y)),
    }
}

pub(super) fn shell_regions_outside_preview(
    preview: PhysicalRect,
    width: u32,
    height: u32,
) -> Vec<PhysicalRect> {
    let right = preview.x.saturating_add(preview.width).min(width);
    let bottom = preview.y.saturating_add(preview.height).min(height);
    [
        PhysicalRect {
            x: 0,
            y: 0,
            width,
            height: preview.y.min(height),
        },
        PhysicalRect {
            x: 0,
            y: bottom,
            width,
            height: height.saturating_sub(bottom),
        },
        PhysicalRect {
            x: 0,
            y: preview.y.min(height),
            width: preview.x.min(width),
            height: bottom.saturating_sub(preview.y.min(height)),
        },
        PhysicalRect {
            x: right,
            y: preview.y.min(height),
            width: width.saturating_sub(right),
            height: bottom.saturating_sub(preview.y.min(height)),
        },
    ]
    .into_iter()
    .filter(|region| region.width > 0 && region.height > 0)
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn logical_rect_scales_to_physical_pixels() {
        assert_eq!(
            LogicalRect::new(10.25, 20.5, 30.0, 40.25).to_physical(2.0),
            PhysicalRect {
                x: 21,
                y: 41,
                width: 60,
                height: 81,
            }
        );
    }

    #[test]
    fn clamp_rect_trims_overflow_at_window_edges() {
        assert_eq!(
            clamp_rect(
                PhysicalRect {
                    x: 900,
                    y: 650,
                    width: 400,
                    height: 300,
                },
                1000,
                700,
            ),
            PhysicalRect {
                x: 900,
                y: 650,
                width: 100,
                height: 50,
            }
        );
    }

    #[test]
    fn shell_regions_cover_only_the_area_outside_preview() {
        let preview = PhysicalRect {
            x: 200,
            y: 100,
            width: 600,
            height: 500,
        };
        let regions = shell_regions_outside_preview(preview, 1000, 700);
        let covered_area: u32 = regions
            .iter()
            .map(|region| region.width * region.height)
            .sum();

        assert_eq!(covered_area, 1000 * 700 - 600 * 500);
        assert!(regions.iter().all(|region| {
            let horizontal_overlap =
                region.x < preview.x + preview.width && preview.x < region.x + region.width;
            let vertical_overlap =
                region.y < preview.y + preview.height && preview.y < region.y + region.height;
            !(horizontal_overlap && vertical_overlap)
        }));
    }

    #[test]
    fn shell_regions_clamp_preview_at_window_edges() {
        let regions = shell_regions_outside_preview(
            PhysicalRect {
                x: 900,
                y: 650,
                width: 400,
                height: 300,
            },
            1000,
            700,
        );
        let covered_area: u32 = regions
            .iter()
            .map(|region| region.width * region.height)
            .sum();

        assert_eq!(covered_area, 1000 * 700 - 100 * 50);
    }
}
