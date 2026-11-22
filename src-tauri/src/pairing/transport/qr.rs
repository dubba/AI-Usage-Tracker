//! QR codes for the air-gap transfer, as a grid of modules the frontend draws itself, so no
//! markup from the backend is ever inserted into the page.

use qrcode::{Color, QrCode};
use serde::{Deserialize, Serialize};

/// A QR code: `size` × `size` modules, row by row, `'1'` for a dark one and `'0'` for a light
/// one. The quiet zone around the code is not included; whoever draws it adds that.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[cfg_attr(test, derive(ts_rs::TS))]
pub struct QrMatrix {
    pub size: usize,
    pub modules: String,
}

pub fn qr_matrix(uri: &str) -> Result<QrMatrix, String> {
    let code = QrCode::new(uri.as_bytes()).map_err(|e| format!("QR Code generation error: {e}"))?;
    let modules = code
        .to_colors()
        .into_iter()
        .map(|color| if color == Color::Dark { '1' } else { '0' })
        .collect();
    Ok(QrMatrix {
        size: code.width(),
        modules,
    })
}
