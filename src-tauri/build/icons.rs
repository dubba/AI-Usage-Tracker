use super::*;

pub(super) const WINDOWS_ICON_SIZES: [u32; 9] = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/// The app icon: a full-bleed square that every platform's icon files are rendered from.
/// iOS and Android cut their own shape out of it; Windows and macOS get a rounded frame.
pub(super) const ICON_SVG: &str = include_str!("../icons/icon.svg");

/// The icon's base color, which also fills the Android adaptive icon background
/// (`ic_launcher_background` in `colors.xml`).
pub(super) const ICON_BACKGROUND: [u8; 3] = [0x0e, 0x0f, 0x1a];

/// The rounded Windows and macOS frame, as fractions of the icon's side.
pub(super) const DESKTOP_CORNER_RADIUS: f32 = 115.0 / 512.0;
pub(super) const DESKTOP_BORDER_WIDTH: f32 = 3.0 / 512.0;

/// Apple's macOS grid: an 824-pixel rounded square centered on a 1024-pixel canvas.
pub(super) const MACOS_ICON_SCALE: f32 = 824.0 / 1024.0;

/// Launchers show the middle 72dp of the 108dp adaptive foreground, and only promise a 66dp
/// circle of it. At 80dp the gauge's outer ring (radius 175.5 of 512) sits well inside that
/// circle, about as large as on iOS, while the square's edges stay outside the 72dp view.
pub(super) const ANDROID_FOREGROUND_SCALE: f32 = 80.0 / 108.0;

pub(super) fn write_file_if_changed<P: AsRef<std::path::Path>>(path: P, data: &[u8]) {
    let path = path.as_ref();
    if let Ok(existing) = fs::read(path) {
        if existing == data {
            return;
        }
    }
    fs::write(path, data).unwrap_or_else(|err| {
        panic!("failed to write {}: {}", path.display(), err);
    });
}

pub(super) fn parse_icon() -> usvg::Tree {
    usvg::Tree::from_str(ICON_SVG, &usvg::Options::default())
        .expect("icons/icon.svg must be a valid SVG")
}

/// Renders the icon `art` pixels wide, centered on a transparent `canvas`-pixel square.
pub(super) fn render_icon(icon: &usvg::Tree, canvas: u32, art: f32) -> tiny_skia::Pixmap {
    let mut pixmap = tiny_skia::Pixmap::new(canvas, canvas).expect("icon size must be non-zero");
    let scale = art / icon.size().width();
    let offset = (canvas as f32 - art) / 2.0;
    let transform = tiny_skia::Transform::from_row(scale, 0.0, 0.0, scale, offset, offset);
    resvg::render(icon, transform, &mut pixmap.as_mut());
    pixmap
}

/// A square with circular corners, drawn with the usual cubic approximation of a quarter circle.
pub(super) fn rounded_square(x: f32, y: f32, side: f32, radius: f32) -> tiny_skia::Path {
    const KAPPA: f32 = 0.552_284_8;
    let (r, c) = (radius, radius * (1.0 - KAPPA));
    let (right, bottom) = (x + side, y + side);
    let mut path = tiny_skia::PathBuilder::new();
    path.move_to(x + r, y);
    path.line_to(right - r, y);
    path.cubic_to(right - c, y, right, y + c, right, y + r);
    path.line_to(right, bottom - r);
    path.cubic_to(right, bottom - c, right - c, bottom, right - r, bottom);
    path.line_to(x + r, bottom);
    path.cubic_to(x + c, bottom, x, bottom - c, x, bottom - r);
    path.line_to(x, y + r);
    path.cubic_to(x, y + c, x + c, y, x + r, y);
    path.close();
    path.finish().expect("rounded square path must be valid")
}

/// The Windows and macOS icon: the square with rounded corners and a thin gradient border.
pub(super) fn render_desktop_icon(icon: &usvg::Tree, canvas: u32, art: f32) -> tiny_skia::Pixmap {
    let mut pixmap = render_icon(icon, canvas, art);
    let offset = (canvas as f32 - art) / 2.0;
    let radius = art * DESKTOP_CORNER_RADIUS;

    let mut mask = tiny_skia::Mask::new(canvas, canvas).expect("icon size must be non-zero");
    mask.fill_path(
        &rounded_square(offset, offset, art, radius),
        tiny_skia::FillRule::Winding,
        true,
        tiny_skia::Transform::identity(),
    );
    pixmap.apply_mask(&mask);

    let width = art * DESKTOP_BORDER_WIDTH;
    let inset = width / 2.0;
    let border = rounded_square(offset + inset, offset + inset, art - width, radius - inset);
    let shader = tiny_skia::LinearGradient::new(
        tiny_skia::Point::from_xy(offset, offset),
        tiny_skia::Point::from_xy(offset + art, offset + art),
        vec![
            tiny_skia::GradientStop::new(0.0, tiny_skia::Color::from_rgba8(0x4a, 0x4d, 0x75, 230)),
            tiny_skia::GradientStop::new(1.0, tiny_skia::Color::from_rgba8(0x1a, 0x1b, 0x2e, 77)),
        ],
        tiny_skia::SpreadMode::Pad,
        tiny_skia::Transform::identity(),
    )
    .expect("border gradient must be valid");
    let paint = tiny_skia::Paint {
        shader,
        anti_alias: true,
        ..Default::default()
    };
    let stroke = tiny_skia::Stroke {
        width,
        ..Default::default()
    };
    pixmap.stroke_path(
        &border,
        &paint,
        &stroke,
        tiny_skia::Transform::identity(),
        None,
    );
    pixmap
}

pub(super) fn encode_image(image: image::DynamicImage) -> Vec<u8> {
    let mut png_cursor = Cursor::new(Vec::new());
    image
        .write_to(&mut png_cursor, ImageFormat::Png)
        .expect("native icon PNG must be encodable");
    png_cursor.into_inner()
}

pub(super) fn encode_png(pixmap: &tiny_skia::Pixmap) -> Vec<u8> {
    let rgba = pixmap
        .pixels()
        .iter()
        .flat_map(|pixel| {
            let color = pixel.demultiply();
            [color.red(), color.green(), color.blue(), color.alpha()]
        })
        .collect();
    let image = image::RgbaImage::from_raw(pixmap.width(), pixmap.height(), rgba)
        .expect("pixmap must hold width * height pixels");
    encode_image(image.into())
}

/// iOS icons must have no alpha channel, so the canvas is filled with the base color first.
pub(super) fn encode_opaque_png(icon: &usvg::Tree, size: u32) -> Vec<u8> {
    let [red, green, blue] = ICON_BACKGROUND;
    let mut pixmap = tiny_skia::Pixmap::new(size, size).expect("icon size must be non-zero");
    pixmap.fill(tiny_skia::Color::from_rgba8(red, green, blue, 255));
    let scale = size as f32 / icon.size().width();
    resvg::render(
        icon,
        tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let rgb = pixmap
        .pixels()
        .iter()
        .flat_map(|pixel| [pixel.red(), pixel.green(), pixel.blue()])
        .collect();
    let image =
        image::RgbImage::from_raw(size, size, rgb).expect("pixmap must hold width * height pixels");
    encode_image(image.into())
}

pub(super) fn write_windows_icon(icon_dir: &Path, icon: &usvg::Tree) {
    let images: Vec<(u32, Vec<u8>)> = WINDOWS_ICON_SIZES
        .into_iter()
        .map(|size| {
            let png = encode_png(&render_desktop_icon(icon, size, size as f32));
            (size, png)
        })
        .collect();

    let directory_size = 6 + images.len() * 16;
    let image_bytes = images.iter().map(|(_, png)| png.len()).sum::<usize>();
    let mut ico = Vec::with_capacity(directory_size + image_bytes);
    ico.extend_from_slice(&0_u16.to_le_bytes());
    ico.extend_from_slice(&1_u16.to_le_bytes());
    ico.extend_from_slice(&(images.len() as u16).to_le_bytes());

    let mut offset = directory_size as u32;
    for (size, png) in &images {
        let dimension = if *size == 256 { 0 } else { *size as u8 };
        ico.push(dimension);
        ico.push(dimension);
        ico.push(0);
        ico.push(0);
        ico.extend_from_slice(&1_u16.to_le_bytes());
        ico.extend_from_slice(&32_u16.to_le_bytes());
        ico.extend_from_slice(&(png.len() as u32).to_le_bytes());
        ico.extend_from_slice(&offset.to_le_bytes());
        offset += png.len() as u32;
    }

    for (_, png) in images {
        ico.extend_from_slice(&png);
    }

    write_file_if_changed(icon_dir.join("icon.ico"), &ico);
}

pub(super) fn write_macos_icon(icon_dir: &Path, icon: &usvg::Tree) {
    let entries: [(&[u8], u32); 7] = [
        (b"icp4", 16),
        (b"icp5", 32),
        (b"icp6", 64),
        (b"ic07", 128),
        (b"ic08", 256),
        (b"ic09", 512),
        (b"ic10", 1024),
    ];

    let mut body = Vec::new();
    for (tag, size) in entries {
        let png = encode_png(&render_desktop_icon(
            icon,
            size,
            size as f32 * MACOS_ICON_SCALE,
        ));
        let entry_len = 8_u32 + png.len() as u32;
        body.extend_from_slice(tag);
        body.extend_from_slice(&entry_len.to_be_bytes());
        body.extend_from_slice(&png);
    }

    let total_len = 8_u32 + body.len() as u32;
    let mut icns = Vec::with_capacity(total_len as usize);
    icns.extend_from_slice(b"icns");
    icns.extend_from_slice(&total_len.to_be_bytes());
    icns.extend_from_slice(&body);

    write_file_if_changed(icon_dir.join("icon.icns"), &icns);
}

pub(super) const ANDROID_MIPMAP_SIZES: [(&str, u32, u32); 5] = [
    ("mipmap-mdpi", 48, 108),
    ("mipmap-hdpi", 72, 162),
    ("mipmap-xhdpi", 96, 216),
    ("mipmap-xxhdpi", 144, 324),
    ("mipmap-xxxhdpi", 192, 432),
];

pub(super) fn write_android_icons(manifest_dir: &Path, icon: &usvg::Tree) {
    let res_dir = manifest_dir.join("gen/android/app/src/main/res");
    if !res_dir.exists() {
        return;
    }

    for (dir_name, launcher_size, foreground_size) in ANDROID_MIPMAP_SIZES {
        let dir = res_dir.join(dir_name);
        let _ = fs::create_dir_all(&dir);

        // Android 7 shows these as drawn, so they keep the rounded frame.
        let launcher_png = encode_png(&render_desktop_icon(
            icon,
            launcher_size,
            launcher_size as f32,
        ));
        write_file_if_changed(dir.join("ic_launcher.png"), &launcher_png);
        write_file_if_changed(dir.join("ic_launcher_round.png"), &launcher_png);

        let foreground_png = encode_png(&render_icon(
            icon,
            foreground_size,
            foreground_size as f32 * ANDROID_FOREGROUND_SCALE,
        ));
        write_file_if_changed(dir.join("ic_launcher_foreground.png"), &foreground_png);
    }

    let anydpi_dir = res_dir.join("mipmap-anydpi-v26");
    let _ = fs::create_dir_all(&anydpi_dir);

    let adaptive_xml = r#"<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
"#;

    write_file_if_changed(anydpi_dir.join("ic_launcher.xml"), adaptive_xml.as_bytes());
    write_file_if_changed(
        anydpi_dir.join("ic_launcher_round.xml"),
        adaptive_xml.as_bytes(),
    );
}

/// Fills every image the iOS asset catalog lists. `tauri ios init` writes Tauri's own
/// logo there, and iOS rounds the corners itself, so these are plain opaque squares.
pub(super) fn write_ios_icons(manifest_dir: &Path, icon: &usvg::Tree) {
    let icon_set = manifest_dir.join("gen/apple/Assets.xcassets/AppIcon.appiconset");
    let Ok(contents) = fs::read_to_string(icon_set.join("Contents.json")) else {
        return;
    };
    let contents: serde_json::Value =
        serde_json::from_str(&contents).expect("AppIcon Contents.json must be valid JSON");
    let images = contents["images"]
        .as_array()
        .expect("AppIcon Contents.json must list images");

    for image in images {
        let Some(filename) = image["filename"].as_str() else {
            continue;
        };
        let points: f32 = image["size"]
            .as_str()
            .and_then(|size| size.split('x').next())
            .and_then(|width| width.parse().ok())
            .expect("AppIcon image size must look like 60x60");
        let scale: f32 = image["scale"]
            .as_str()
            .and_then(|scale| scale.strip_suffix('x'))
            .and_then(|scale| scale.parse().ok())
            .expect("AppIcon image scale must look like 2x");
        let pixels = (points * scale).round() as u32;
        write_file_if_changed(icon_set.join(filename), &encode_opaque_png(icon, pixels));
    }
}
