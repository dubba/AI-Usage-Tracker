use base64::{engine::general_purpose::STANDARD, Engine};
use image::{imageops::FilterType, ImageFormat};
use std::{env, fs, io::Cursor, path::PathBuf};

fn write_windows_icon(icon_dir: &PathBuf, source_png: &[u8]) {
    let image = image::load_from_memory_with_format(source_png, ImageFormat::Png)
        .expect("embedded application icon must be a valid PNG");
    let resized = image.resize_exact(256, 256, FilterType::Lanczos3);
    let mut png_cursor = Cursor::new(Vec::new());
    resized
        .write_to(&mut png_cursor, ImageFormat::Png)
        .expect("Windows icon PNG must be encodable");
    let png = png_cursor.into_inner();

    // ICO header + one 256x256 PNG-backed image directory entry.
    let mut ico = Vec::with_capacity(22 + png.len());
    ico.extend_from_slice(&0_u16.to_le_bytes());
    ico.extend_from_slice(&1_u16.to_le_bytes());
    ico.extend_from_slice(&1_u16.to_le_bytes());
    ico.extend_from_slice(&[0, 0, 0, 0]);
    ico.extend_from_slice(&1_u16.to_le_bytes());
    ico.extend_from_slice(&32_u16.to_le_bytes());
    ico.extend_from_slice(&(png.len() as u32).to_le_bytes());
    ico.extend_from_slice(&22_u32.to_le_bytes());
    ico.extend_from_slice(&png);

    fs::write(icon_dir.join("icon.ico"), ico)
        .expect("Windows application icon must be writable during the build");
}

fn write_macos_icon(icon_dir: &PathBuf, source_png: &[u8]) {
    // A 512x512 PNG stored as the standard ic09 ICNS entry.
    let entry_len = 8_u32 + source_png.len() as u32;
    let total_len = 8_u32 + entry_len;
    let mut icns = Vec::with_capacity(total_len as usize);
    icns.extend_from_slice(b"icns");
    icns.extend_from_slice(&total_len.to_be_bytes());
    icns.extend_from_slice(b"ic09");
    icns.extend_from_slice(&entry_len.to_be_bytes());
    icns.extend_from_slice(source_png);

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

    fs::write(icon_dir.join("icon.png"), &icon_bytes)
        .expect("application icon must be writable during the build");
    write_windows_icon(&icon_dir, &icon_bytes);
    write_macos_icon(&icon_dir, &icon_bytes);

    tauri_build::build()
}
