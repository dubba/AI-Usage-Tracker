//! QR codes for the pairing link.

use qrcode::{render::svg, QrCode};

pub fn generate_qr_svg(uri: &str) -> Result<String, String> {
    let code = QrCode::new(uri.as_bytes()).map_err(|e| format!("QR Code generation error: {e}"))?;
    let image = code
        .render::<svg::Color>()
        .min_dimensions(240, 240)
        .dark_color(svg::Color("#000000"))
        .light_color(svg::Color("#ffffff"))
        .build();

    let trimmed = image.trim();
    if !trimmed.starts_with("<?xml") && !trimmed.starts_with("<svg") {
        return Err("Generated QR is not valid SVG markup".into());
    }
    if !trimmed.contains("<svg") || !trimmed.ends_with("</svg>") {
        return Err("Malformed QR SVG markup".into());
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("<script")
        || lower.contains("<foreignobject")
        || lower.contains("<use")
        || lower.contains("onload")
        || lower.contains("onerror")
        || lower.contains("javascript:")
    {
        return Err("Generated QR SVG contains disallowed elements or attributes".into());
    }

    Ok(image)
}
