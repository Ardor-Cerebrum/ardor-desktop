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

#[derive(Clone, Debug, PartialEq)]
pub(super) struct LayoutSnapshot {
    pub(super) generation: u64,
    pub(super) scale: f64,
    pub(super) window: PhysicalRect,
    pub(super) preview: LogicalRect,
    pub(super) overlays: Vec<LogicalRect>,
    pub(super) preview_visible: bool,
}

impl LayoutSnapshot {
    pub(super) fn new(
        generation: u64,
        scale: f64,
        window_width: u32,
        window_height: u32,
        preview: LogicalRect,
        overlays: Vec<LogicalRect>,
        preview_visible: bool,
    ) -> Self {
        Self {
            generation,
            scale: scale.max(0.01),
            window: PhysicalRect {
                x: 0,
                y: 0,
                width: window_width,
                height: window_height,
            },
            preview,
            overlays,
            preview_visible,
        }
    }

    pub(super) fn preview_physical(&self) -> PhysicalRect {
        self.preview.to_physical(self.scale)
    }

    pub(super) fn overlays_physical(&self) -> Vec<PhysicalRect> {
        self.overlays
            .iter()
            .copied()
            .map(|overlay| overlay.to_physical(self.scale))
            .collect()
    }

    pub(super) fn same_geometry(&self, other: &Self) -> bool {
        self.scale == other.scale
            && self.window == other.window
            && self.preview == other.preview
            && self.overlays == other.overlays
            && self.preview_visible == other.preview_visible
    }
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

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct PopupPlacement {
    pub(super) viewport_x: i64,
    pub(super) viewport_y: i64,
    pub(super) viewport_width: u32,
    pub(super) viewport_height: u32,
    pub(super) scissor: PhysicalRect,
}

#[allow(clippy::too_many_arguments)]
pub(super) fn popup_placement(
    preview: PhysicalRect,
    popup_x: i32,
    popup_y: i32,
    popup_width: i32,
    popup_height: i32,
    scale: f64,
    window_width: u32,
    window_height: u32,
) -> PopupPlacement {
    let scale = scale.max(0.01);
    let width = (f64::from(popup_width.max(0)) * scale).round().max(0.0) as u32;
    let height = (f64::from(popup_height.max(0)) * scale).round().max(0.0) as u32;
    let popup_left = i64::from(preview.x) + (f64::from(popup_x) * scale).round() as i64;
    let popup_top = i64::from(preview.y) + (f64::from(popup_y) * scale).round() as i64;
    let preview_left = i64::from(preview.x.min(window_width));
    let preview_top = i64::from(preview.y.min(window_height));
    let preview_right = i64::from(preview.x.saturating_add(preview.width).min(window_width));
    let preview_bottom = i64::from(preview.y.saturating_add(preview.height).min(window_height));
    let left = popup_left.clamp(preview_left, preview_right);
    let top = popup_top.clamp(preview_top, preview_bottom);
    let right = popup_left
        .saturating_add(i64::from(width))
        .clamp(left, preview_right);
    let bottom = popup_top
        .saturating_add(i64::from(height))
        .clamp(top, preview_bottom);
    PopupPlacement {
        viewport_x: popup_left,
        viewport_y: popup_top,
        viewport_width: width,
        viewport_height: height,
        scissor: PhysicalRect {
            x: left as u32,
            y: top as u32,
            width: right.saturating_sub(left) as u32,
            height: bottom.saturating_sub(top) as u32,
        },
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
    fn popup_placement_preserves_full_viewport_when_clipping_negative_offsets() {
        assert_eq!(
            popup_placement(
                PhysicalRect {
                    x: 10,
                    y: 5,
                    width: 400,
                    height: 300,
                },
                -20,
                -10,
                80,
                40,
                2.0,
                640,
                480,
            ),
            PopupPlacement {
                viewport_x: -30,
                viewport_y: -15,
                viewport_width: 160,
                viewport_height: 80,
                scissor: PhysicalRect {
                    x: 10,
                    y: 5,
                    width: 120,
                    height: 60,
                },
            },
        );
    }

    #[test]
    fn popup_placement_preserves_popup_inside_preview() {
        let preview = PhysicalRect {
            x: 10,
            y: 5,
            width: 120,
            height: 60,
        };

        assert_eq!(
            popup_placement(preview, 10, 5, 80, 40, 1.0, 300, 200),
            PopupPlacement {
                viewport_x: 20,
                viewport_y: 10,
                viewport_width: 80,
                viewport_height: 40,
                scissor: PhysicalRect {
                    x: 20,
                    y: 10,
                    width: 80,
                    height: 40,
                },
            },
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

    #[test]
    fn layout_snapshot_derives_every_physical_rect_from_one_scale() {
        let snapshot = LayoutSnapshot::new(
            7,
            2.0,
            1440,
            900,
            LogicalRect::new(100.0, 50.0, 400.0, 300.0),
            vec![LogicalRect::new(180.0, 90.0, 120.0, 80.0)],
            true,
        );

        assert_eq!(snapshot.generation, 7);
        assert_eq!(
            snapshot.preview_physical(),
            PhysicalRect {
                x: 200,
                y: 100,
                width: 800,
                height: 600,
            }
        );
        assert_eq!(
            snapshot.overlays_physical(),
            vec![PhysicalRect {
                x: 360,
                y: 180,
                width: 240,
                height: 160,
            }]
        );
    }
}
