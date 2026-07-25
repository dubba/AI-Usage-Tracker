use base64::{engine::general_purpose::STANDARD, Engine};
use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=icons/app-icon.b64");

    let icon_bytes = STANDARD
        .decode(include_str!("icons/app-icon.b64").trim())
        .expect("embedded application icon must be valid base64");
    let manifest_dir = PathBuf::from(
        env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR must be available"),
    );
    fs::write(manifest_dir.join("icons/icon.png"), icon_bytes)
        .expect("application icon must be writable during the build");

    tauri_build::build()
}
