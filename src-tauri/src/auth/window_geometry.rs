//! Where a sign-in window opens: centered over the window it belongs to.

/// Calculates logical width, height, and (x, y) coordinates to center a window over
/// a target window, covering the requested ratio of the target's dimensions while
/// respecting minimum sizes and monitor bounds.
#[cfg(desktop)]
pub(crate) fn calculate_centered_geometry(
    target_pos: (f64, f64),
    target_size: (f64, f64),
    monitor_bounds: Option<((f64, f64), (f64, f64))>,
    width_ratio: f64,
    height_ratio: f64,
    min_width: f64,
    min_height: f64,
) -> (f64, f64, (f64, f64)) {
    let (target_x, target_y) = target_pos;
    let (target_w, target_h) = target_size;

    let width = if width_ratio > 0.0 {
        (target_w * width_ratio).max(min_width)
    } else {
        min_width
    };

    let height = if height_ratio > 0.0 {
        (target_h * height_ratio).max(min_height)
    } else {
        min_height
    };

    let mut x = target_x + (target_w - width) / 2.0;
    let mut y = target_y + (target_h - height) / 2.0;

    if let Some(((mon_left, mon_top), (mon_right, mon_bottom))) = monitor_bounds {
        if x + width > mon_right {
            x = (mon_right - width).max(mon_left);
        }
        if x < mon_left {
            x = mon_left;
        }
        if y + height > mon_bottom {
            y = (mon_bottom - height).max(mon_top);
        }
        if y < mon_top {
            y = mon_top;
        }
    }

    (width, height, (x, y))
}

/// Returns the logical width, height, and optional (x, y) position to open a window
/// centered directly on `target_window_label` (falling back to `"main"`).
#[cfg(desktop)]
pub(crate) fn window_geometry_centered_on(
    handle: &tauri::AppHandle,
    target_window_label: &str,
    width_ratio: f64,
    height_ratio: f64,
    min_width: f64,
    min_height: f64,
) -> (f64, f64, Option<(f64, f64)>) {
    use tauri::Manager;
    let target = handle
        .get_webview_window(target_window_label)
        .or_else(|| handle.get_webview_window("main"));

    let Some(window) = target else {
        return (min_width.max(1080.0), min_height.max(760.0), None);
    };

    let Ok(pos) = window.outer_position() else {
        return (min_width.max(1080.0), min_height.max(760.0), None);
    };
    let Ok(size) = window.outer_size() else {
        return (min_width.max(1080.0), min_height.max(760.0), None);
    };
    let scale = window.scale_factor().unwrap_or(1.0).max(0.1);

    let target_pos = (pos.x as f64 / scale, pos.y as f64 / scale);
    let target_size = (size.width as f64 / scale, size.height as f64 / scale);

    let (width, height, (x, y)) = calculate_centered_geometry(
        target_pos,
        target_size,
        None,
        width_ratio,
        height_ratio,
        min_width,
        min_height,
    );

    crate::diagnostics::info(&format!(
        "Centering login window on '{target_window_label}': target pos=({:.1}, {:.1}) size=({:.1}, {:.1}), computed size=({:.1}, {:.1}) pos=({:.1}, {:.1})",
        target_pos.0, target_pos.1, target_size.0, target_size.1, width, height, x, y
    ));

    (width, height, Some((x, y)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(desktop)]
    #[test]
    fn centers_window_over_target_window() {
        let target_pos = (100.0, 100.0);
        let target_size = (1440.0, 850.0);
        let (width, height, (x, y)) =
            calculate_centered_geometry(target_pos, target_size, None, 0.96, 0.96, 820.0, 620.0);
        assert!((width - 1382.4).abs() < 1e-4);
        assert!((height - 816.0).abs() < 1e-4);
        let target_center_x = target_pos.0 + target_size.0 / 2.0;
        let target_center_y = target_pos.1 + target_size.1 / 2.0;
        let window_center_x = x + width / 2.0;
        let window_center_y = y + height / 2.0;
        assert!((target_center_x - window_center_x).abs() < 1e-4);
        assert!((target_center_y - window_center_y).abs() < 1e-4);
    }

    #[cfg(desktop)]
    #[test]
    fn fixed_size_window_centers_over_target() {
        let target_pos = (200.0, 150.0);
        let target_size = (1000.0, 700.0);
        let (width, height, (x, y)) =
            calculate_centered_geometry(target_pos, target_size, None, 0.0, 0.0, 640.0, 800.0);
        assert_eq!(width, 640.0);
        assert_eq!(height, 800.0);
        let target_center_x = target_pos.0 + target_size.0 / 2.0;
        let target_center_y = target_pos.1 + target_size.1 / 2.0;
        assert_eq!(x + width / 2.0, target_center_x);
        assert_eq!(y + height / 2.0, target_center_y);
    }

    #[cfg(desktop)]
    #[test]
    fn clamps_within_monitor_bounds() {
        let target_pos = (1800.0, 900.0);
        let target_size = (500.0, 400.0);
        let monitor = Some(((0.0, 0.0), (1920.0, 1080.0)));
        let (width, height, (x, y)) =
            calculate_centered_geometry(target_pos, target_size, monitor, 0.0, 0.0, 640.0, 800.0);
        assert_eq!(width, 640.0);
        assert_eq!(height, 800.0);
        assert!(x + width <= 1920.0);
        assert!(y + height <= 1080.0);
        assert!(x >= 0.0);
        assert!(y >= 0.0);
    }

    #[cfg(desktop)]
    #[test]
    fn nested_popups_share_the_exact_same_center_point() {
        let main_pos = (350.0, 80.0);
        let main_size = (1440.0, 900.0);
        // Provider login window covers the full main-window width
        let (provider_w, provider_h, (provider_x, provider_y)) =
            calculate_centered_geometry(main_pos, main_size, None, 1.0, 0.96, 820.0, 620.0);
        // Sign-in popup (e.g. Google) centered on provider login window
        let (popup_w, popup_h, (popup_x, popup_y)) = calculate_centered_geometry(
            (provider_x, provider_y),
            (provider_w, provider_h),
            None,
            0.0,
            0.0,
            640.0,
            1040.0,
        );

        let main_center = (
            main_pos.0 + main_size.0 / 2.0,
            main_pos.1 + main_size.1 / 2.0,
        );
        let provider_center = (provider_x + provider_w / 2.0, provider_y + provider_h / 2.0);
        let popup_center = (popup_x + popup_w / 2.0, popup_y + popup_h / 2.0);

        assert!((main_center.0 - provider_center.0).abs() < 1e-4);
        assert!((main_center.1 - provider_center.1).abs() < 1e-4);
        // Full-width coverage: same left edge and width as the main window.
        assert!((provider_x - main_pos.0).abs() < 1e-4);
        assert!((provider_w - main_size.0).abs() < 1e-4);
        assert!((provider_center.0 - popup_center.0).abs() < 1e-4);
        assert!((provider_center.1 - popup_center.1).abs() < 1e-4);
    }
}
