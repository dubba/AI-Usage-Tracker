//! Rust and the Android Kotlin code call each other by name, and no compiler checks those names.
//!
//! - Rust calls methods on `MainActivity` (and `CredentialVault`) through JNI, as a method name
//!   plus a JNI type signature, for example `"isWifiEnabled", "()Z"`.
//! - Kotlin calls Rust through `external fun`s, which JNI finds by the exported symbol
//!   `Java_com_dubba_ai_usage_tracker_<Class>_<method>`.
//!
//! A rename or a changed parameter on either side still builds, and fails only on a phone when
//! the feature is used. These tests read both sides from disk and fail on any mismatch.

use std::{
    fs,
    path::{Path, PathBuf},
};

const KOTLIN_DIR: &str = "gen/android/app/src/main/java/com/dubba/ai/usage/tracker";
const PACKAGE_SYMBOL_PREFIX: &str = "Java_com_dubba_ai_usage_tracker_";

/// Methods Rust calls on Java library objects rather than on the app's own classes.
const JAVA_LIBRARY_METHODS: &[&str] = &["getMessage"];

/// The Keystore methods, called on `MainActivity` or, in a background run with no activity, on
/// `CredentialVault`. `android_keystore.rs` passes their names and signature separately.
const KEYSTORE_METHODS: &[&str] = &["encryptCredential", "decryptCredential"];
const KEYSTORE_SIGNATURE: &str = "([B[B)[B";

fn manifest_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}

/// Every Rust source under `src/` except this file (whose examples would be read as calls), as
/// (path relative to `src/`, text).
fn rust_sources() -> Vec<(String, String)> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<(String, String)>) {
        for entry in fs::read_dir(dir).expect("read src") {
            let path = entry.expect("dir entry").path();
            if path.is_dir() {
                walk(root, &path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                let relative = path.strip_prefix(root).expect("under src");
                if relative == Path::new("android_bridge_contract.rs") {
                    continue;
                }
                let text = fs::read_to_string(&path).expect("read rust file");
                out.push((relative.display().to_string(), text.replace("\r\n", "\n")));
            }
        }
    }
    let root = manifest_path("src");
    let mut out = Vec::new();
    walk(&root, &root, &mut out);
    out
}

fn kotlin(class: &str) -> String {
    let path = manifest_path(&format!("{KOTLIN_DIR}/{class}.kt"));
    fs::read_to_string(&path)
        .unwrap_or_else(|_| panic!("{} is missing", path.display()))
        .replace("\r\n", "\n")
}

/// Whether `text` is a whole JNI method signature such as `(Ljava/lang/String;Z)I`.
fn is_jni_signature(text: &str) -> bool {
    let Some(rest) = text.strip_prefix('(') else {
        return false;
    };
    let Some((params, ret)) = rest.split_once(')') else {
        return false;
    };
    let types = |mut s: &str, allow_void: bool| -> Option<usize> {
        let mut count = 0;
        while !s.is_empty() {
            s = s.trim_start_matches('[');
            let len = match s.as_bytes().first()? {
                b'Z' | b'B' | b'C' | b'S' | b'I' | b'J' | b'F' | b'D' => 1,
                b'V' if allow_void => 1,
                b'L' => s.find(';')? + 1,
                _ => return None,
            };
            s = &s[len..];
            count += 1;
        }
        Some(count)
    };
    types(params, false).is_some() && types(ret, true) == Some(1)
}

/// Every `"name", "(signature)"` pair of string literals in `source`: the method name and JNI
/// signature passed to `env.call_method` or to a helper that forwards them.
fn named_calls(source: &str) -> Vec<(String, String)> {
    let mut calls = Vec::new();
    for (start, _) in source.match_indices("\"(") {
        let sig_start = start + 1;
        let Some(sig_len) = source[sig_start..].find('"') else {
            continue;
        };
        let signature = &source[sig_start..sig_start + sig_len];
        if !is_jni_signature(signature) {
            continue;
        }
        // The literal just before, separated only by a comma and whitespace, is the name.
        let before = source[..start].trim_end();
        let Some(before) = before.strip_suffix(',') else {
            continue;
        };
        let Some(before) = before.trim_end().strip_suffix('"') else {
            continue;
        };
        let Some(name_start) = before.rfind('"') else {
            continue;
        };
        let name = &before[name_start + 1..];
        let is_method_name = name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
            && name.chars().all(|c| c.is_ascii_alphanumeric());
        if is_method_name {
            calls.push((name.to_string(), signature.to_string()));
        }
    }
    calls
}

/// The Kotlin type JNI expects for one signature type.
fn kotlin_type(jni: &str) -> String {
    match jni {
        "Z" => "Boolean".into(),
        "B" => "Byte".into(),
        "C" => "Char".into(),
        "S" => "Short".into(),
        "I" => "Int".into(),
        "J" => "Long".into(),
        "F" => "Float".into(),
        "D" => "Double".into(),
        "V" => "Unit".into(),
        "[B" => "ByteArray".into(),
        "Ljava/lang/String;" => "String".into(),
        other => panic!("add a Kotlin type for JNI type {other}"),
    }
}

/// The parameter and return types, as Kotlin names, of a JNI signature.
fn signature_types(signature: &str) -> (Vec<String>, String) {
    let (params, ret) = signature[1..].split_once(')').expect("signature");
    let mut types = Vec::new();
    let mut rest = params;
    while !rest.is_empty() {
        let arrays = rest.len() - rest.trim_start_matches('[').len();
        let after = &rest[arrays..];
        let len = if after.starts_with('L') {
            after.find(';').expect("class type end") + 1
        } else {
            1
        };
        types.push(kotlin_type(&rest[..arrays + len]));
        rest = &rest[arrays + len..];
    }
    (types, kotlin_type(ret))
}

/// A `fun` declaration found in a Kotlin source.
struct KotlinFun {
    private: bool,
    params: Vec<String>,
    /// `None` when the function has an expression body and no declared type.
    ret: Option<String>,
}

fn kotlin_funs(source: &str, name: &str) -> Vec<KotlinFun> {
    let needle = format!("fun {name}(");
    source
        .match_indices(&needle)
        .map(|(at, _)| {
            let line_start = source[..at].rfind('\n').map_or(0, |i| i + 1);
            let private = source[line_start..at].contains("private");
            let open = at + needle.len();
            let close = open + source[open..].find(')').expect("parameter list end");
            let params = source[open..close]
                .split(',')
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .map(|p| {
                    let ty = p.split_once(':').expect("typed parameter").1;
                    ty.split('=').next().unwrap().trim().to_string()
                })
                .collect();
            let after = source[close + 1..].trim_start();
            let ret = if let Some(typed) = after.strip_prefix(':') {
                let typed = typed.trim_start();
                let end = typed
                    .find(|c: char| c.is_whitespace() || c == '=' || c == '{')
                    .unwrap_or(typed.len());
                Some(typed[..end].to_string())
            } else if after.starts_with('{') {
                Some("Unit".to_string())
            } else {
                None
            };
            KotlinFun {
                private,
                params,
                ret,
            }
        })
        .collect()
}

/// Checks that `class` has a public method JNI can call as `name` with `signature`.
fn check_method(class: &str, source: &str, name: &str, signature: &str) -> Option<String> {
    let (params, ret) = signature_types(signature);
    let funs = kotlin_funs(source, name);
    if funs.is_empty() {
        return Some(format!(
            "{class}.{name}{signature}: no `fun {name}(` in {class}.kt"
        ));
    }
    let matching = funs.iter().find(|f| f.params == params);
    let Some(found) = matching else {
        return Some(format!(
            "{class}.{name}{signature}: Rust passes ({}), Kotlin takes ({})",
            params.join(", "),
            funs[0].params.join(", ")
        ));
    };
    if found.private {
        return Some(format!("{class}.{name}: private, so JNI cannot call it"));
    }
    match &found.ret {
        Some(declared) if *declared != ret => Some(format!(
            "{class}.{name}{signature}: Rust expects {ret}, Kotlin returns {declared}"
        )),
        // An expression body without a declared type returns whatever its expression does,
        // which this test cannot read. Only a call that expects nothing back is accepted then.
        None if ret != "Unit" => Some(format!(
            "{class}.{name}: declare the return type ({ret}) so this test can check it"
        )),
        _ => None,
    }
}

#[test]
fn every_kotlin_method_rust_calls_exists_with_the_same_signature() {
    let activity = kotlin("MainActivity");
    let mut calls: Vec<(String, String, String)> = Vec::new();
    for (path, source) in rust_sources() {
        for (name, signature) in named_calls(&source) {
            if !JAVA_LIBRARY_METHODS.contains(&name.as_str()) {
                calls.push((path.clone(), name, signature));
            }
        }
    }
    // Guards the scan itself: if it stops finding calls, the test would pass on nothing.
    for expected in ["isWifiEnabled", "openSignInTab", "showUpdateAvailable"] {
        assert!(
            calls.iter().any(|(_, name, _)| name == expected),
            "the scan no longer finds the call to {expected}"
        );
    }

    let problems: Vec<String> = calls
        .iter()
        .filter_map(|(path, name, signature)| {
            check_method("MainActivity", &activity, name, signature)
                .map(|problem| format!("{problem} (called from {path})"))
        })
        .collect();
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn the_keystore_methods_exist_on_the_activity_and_the_vault() {
    let keystore = fs::read_to_string(manifest_path("src/platform/android_keystore.rs"))
        .expect("android_keystore.rs");
    assert!(keystore.contains(&format!("\"{KEYSTORE_SIGNATURE}\"")));
    assert_eq!(
        keystore.matches("call(\"").count(),
        KEYSTORE_METHODS.len(),
        "android_keystore.rs calls a Keystore method this test does not list"
    );
    let mut problems = Vec::new();
    for name in KEYSTORE_METHODS {
        assert!(keystore.contains(&format!("call(\"{name}\"")), "{name}");
        for class in ["MainActivity", "CredentialVault"] {
            problems.extend(check_method(
                class,
                &kotlin(class),
                name,
                KEYSTORE_SIGNATURE,
            ));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn every_kotlin_external_fun_has_a_rust_export_and_back() {
    let rust: String = rust_sources()
        .into_iter()
        .map(|(_, source)| source)
        .collect();
    let exports: Vec<String> = rust
        .match_indices(&format!("extern \"C\" fn {PACKAGE_SYMBOL_PREFIX}"))
        .map(|(at, matched)| {
            let start = at + matched.len();
            let end = start
                + rust[start..]
                    .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
                    .expect("symbol end");
            rust[start..end].to_string()
        })
        .collect();
    assert!(
        !exports.is_empty(),
        "the scan no longer finds the Rust exports"
    );

    let mut problems = Vec::new();
    let mut externals = Vec::new();
    for entry in fs::read_dir(manifest_path(KOTLIN_DIR)).expect("Kotlin folder") {
        let path = entry.expect("dir entry").path();
        let Some(class) = path
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.strip_suffix(".kt"))
        else {
            continue;
        };
        let source = kotlin(class);
        for (at, matched) in source.match_indices("external fun ") {
            let start = at + matched.len();
            let end = start + source[start..].find('(').expect("external fun name end");
            externals.push(format!("{class}_{}", &source[start..end]));
        }
    }
    for symbol in &externals {
        if !exports.contains(symbol) {
            problems.push(format!(
                "Kotlin declares `external fun` {symbol} but Rust exports no {PACKAGE_SYMBOL_PREFIX}{symbol}"
            ));
        }
    }
    for symbol in &exports {
        if !externals.contains(symbol) {
            problems.push(format!(
                "Rust exports {PACKAGE_SYMBOL_PREFIX}{symbol} but no Kotlin class declares it as `external fun`"
            ));
        }
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn the_signature_reader_handles_each_shape() {
    assert!(is_jni_signature("()V"));
    assert!(is_jni_signature("([B[B)[B"));
    assert!(is_jni_signature("(Ljava/lang/String;Z)I"));
    assert!(!is_jni_signature("(empty)"));
    assert!(!is_jni_signature("(none)"));
    assert_eq!(
        signature_types("(Ljava/lang/String;Z)I"),
        (
            vec!["String".to_string(), "Boolean".to_string()],
            "Int".to_string()
        )
    );
    assert_eq!(
        named_calls("env.call_method(\n    activity,\n    \"openSignInTab\",\n    \"(Ljava/lang/String;Z)I\",\n"),
        vec![("openSignInTab".to_string(), "(Ljava/lang/String;Z)I".to_string())]
    );
}
