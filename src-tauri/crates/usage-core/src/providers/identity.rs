//! Finds who an account belongs to (an email address or a handle) in what a cookie-based
//! sign-in leaves behind: a JWT, a JSON profile, or a cookie header. Grok and OpenCode Go
//! both sign in this way.

use base64::{
    engine::general_purpose::{URL_SAFE, URL_SAFE_NO_PAD},
    Engine,
};
use serde_json::Value;

fn percent_decode(input: &str) -> String {
    let mut bytes = Vec::with_capacity(input.len());
    let mut chars = input.bytes();
    while let Some(b) = chars.next() {
        if b == b'%' {
            let h1 = chars.next();
            let h2 = chars.next();
            if let (Some(h1), Some(h2)) = (h1, h2) {
                let hex_str = [h1, h2];
                if let Ok(hex_str) = std::str::from_utf8(&hex_str) {
                    if let Ok(val) = u8::from_str_radix(hex_str, 16) {
                        bytes.push(val);
                        continue;
                    }
                }
            }
        }
        bytes.push(b);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

pub fn extract_identity_from_jwt(token: &str) -> Option<String> {
    let segment = token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD
        .decode(segment)
        .or_else(|_| URL_SAFE.decode(segment))
        .or_else(|_| {
            let padded = match segment.len() % 4 {
                2 => format!("{segment}=="),
                3 => format!("{segment}="),
                _ => segment.to_string(),
            };
            URL_SAFE_NO_PAD
                .decode(padded.as_bytes())
                .or_else(|_| URL_SAFE.decode(padded.as_bytes()))
        })
        .ok()?;
    let value: Value = serde_json::from_slice(&decoded).ok()?;
    find_identity_in_json(&value)
}

pub fn find_identity_in_json(value: &Value) -> Option<String> {
    // 1. Email addresses (highest priority)
    for key in &["email", "email_address", "user_email", "mail"] {
        if let Some(s) = value.get(*key).and_then(Value::as_str) {
            let s = s.trim();
            if !s.is_empty() && s.contains('@') {
                return Some(s.to_string());
            }
        }
    }
    // 2. User handles / usernames / names
    for key in &["preferred_username", "username", "screen_name", "handle"] {
        if let Some(s) = value.get(*key).and_then(Value::as_str) {
            let s = s.trim();
            if !s.is_empty()
                && !s.eq_ignore_ascii_case("grok")
                && !s.eq_ignore_ascii_case("user")
                && !s.eq_ignore_ascii_case("supergrok")
            {
                if s.contains('@') {
                    return Some(s.to_string());
                }
                return Some(if s.starts_with('@') {
                    s.to_string()
                } else {
                    format!("@{s}")
                });
            }
        }
    }
    // 3. Search nested objects
    for obj_key in &[
        "user", "data", "profile", "account", "session", "claims", "identity",
    ] {
        if let Some(obj) = value.get(*obj_key) {
            if let Some(identity) = find_identity_in_json(obj) {
                return Some(identity);
            }
        }
    }
    None
}

pub fn extract_identity_from_cookies(cookie_header: &str) -> Option<String> {
    for part in cookie_header.split(';') {
        let trimmed = part.trim();
        let Some((key, val)) = trimmed.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let val = val.trim();
        let decoded = percent_decode(val);

        if (key.eq_ignore_ascii_case("email") || key.eq_ignore_ascii_case("user_email"))
            && (val.contains('@') || decoded.contains('@'))
        {
            if decoded.contains('@') {
                return Some(decoded.trim().to_string());
            }
            return Some(val.to_string());
        }

        if val.contains('.') || decoded.contains('.') {
            if let Some(identity) =
                extract_identity_from_jwt(val).or_else(|| extract_identity_from_jwt(&decoded))
            {
                return Some(identity);
            }
        }

        if (key.eq_ignore_ascii_case("username") || key.eq_ignore_ascii_case("screen_name"))
            && !decoded.is_empty()
            && !decoded.eq_ignore_ascii_case("grok")
        {
            return Some(if decoded.starts_with('@') {
                decoded
            } else {
                format!("@{decoded}")
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_email_from_jwt_and_cookie_header() {
        // Sample JWT payload with email: {"sub":"123","email":"test.user@example.com"}
        let jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMiLCJlbWFpbCI6InRlc3QudXNlckBleGFtcGxlLmNvbSJ9.signature";
        assert_eq!(
            extract_identity_from_jwt(jwt).as_deref(),
            Some("test.user@example.com")
        );

        let cookie_header = format!("sso-token={jwt}; theme=dark; session=active");
        assert_eq!(
            extract_identity_from_cookies(&cookie_header).as_deref(),
            Some("test.user@example.com")
        );

        let plain_cookie = "email=user%40example.com; path=/";
        assert_eq!(
            extract_identity_from_cookies(plain_cookie).as_deref(),
            Some("user@example.com")
        );
    }
}
