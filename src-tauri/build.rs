use base64::{engine::general_purpose::STANDARD, Engine};
use image::{imageops::FilterType, ImageFormat};
use std::{env, fs, io::Cursor, path::PathBuf};

const WINDOWS_ICON_SIZES: [u32; 9] = [16, 20, 24, 32, 40, 48, 64, 128, 256];

fn encode_png(source: &image::DynamicImage, size: u32) -> Vec<u8> {
    let resized = source.resize_exact(size, size, FilterType::Lanczos3);
    let mut png_cursor = Cursor::new(Vec::new());
    resized
        .write_to(&mut png_cursor, ImageFormat::Png)
        .expect("native icon PNG must be encodable");
    png_cursor.into_inner()
}

fn write_windows_icon(icon_dir: &PathBuf, image: &image::DynamicImage) {
    let images: Vec<(u32, Vec<u8>)> = WINDOWS_ICON_SIZES
        .into_iter()
        .map(|size| (size, encode_png(image, size)))
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

    fs::write(icon_dir.join("icon.ico"), ico)
        .expect("Windows application icon must be writable during the build");
}

fn write_macos_icon(icon_dir: &PathBuf, image: &image::DynamicImage) {
    let entries: [(&[u8], u32); 6] = [
        (b"icp4", 16),
        (b"icp5", 32),
        (b"icp6", 64),
        (b"ic07", 128),
        (b"ic08", 256),
        (b"ic09", 512),
    ];

    let mut body = Vec::new();
    for (tag, size) in entries {
        let png = encode_png(image, size);
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

    fs::write(icon_dir.join("icon.icns"), icns)
        .expect("macOS application icon must be writable during the build");
}

fn main() {
    println!("cargo:rerun-if-changed=icons/app-icon.b64");

    let icon_bytes = STANDARD
        .decode(include_str!("icons/app-icon.b64").trim())
        .expect("embedded application icon must be valid base64");
    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be available"),
    );
    let icon_dir = manifest_dir.join("icons");

    let image = image::load_from_memory_with_format(&icon_bytes, ImageFormat::Png)
        .expect("embedded application icon must be a valid PNG");

    fs::write(icon_dir.join("icon.png"), encode_png(&image, 128))
        .expect("application icon must be writable during the build");
    fs::write(icon_dir.join("32x32.png"), encode_png(&image, 32))
        .expect("32x32 icon must be writable during the build");
    fs::write(icon_dir.join("128x128.png"), encode_png(&image, 128))
        .expect("128x128 icon must be writable during the build");
    fs::write(icon_dir.join("128x128@2x.png"), encode_png(&image, 256))
        .expect("128x128@2x icon must be writable during the build");

    write_windows_icon(&icon_dir, &image);
    write_macos_icon(&icon_dir, &image);

    tauri_build::build()
}
