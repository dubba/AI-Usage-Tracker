//! The TypeScript types of the backend values the frontend receives (`src/types.ts`).
//!
//! `ts_rs::TS` is derived (in tests only) on everything the frontend receives, and
//! `generated_bindings_are_current` writes the declarations to `src/types.generated.ts`, which
//! `src/types.ts` re-exports. Because the declarations come from the same types serde serializes,
//! a field added, renamed or made nullable in Rust changes the TypeScript type too, and
//! `npm run check` fails wherever the frontend no longer fits it.
//!
//! The two can still disagree in two places: a hand-written `#[ts(type = "...")]` override, which
//! narrows a string field to a union (keep it in step with the values the field is given), and a
//! serde attribute ts-rs does not understand (it warns about those when the tests build).
//!
//! After an intended change, rewrite the file with
//! `UPDATE_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml --lib type_contract`.

use crate::commands::error::{CommandError, ErrorCode};
use crate::commands::pairing::IncomingWatchInfo;
use crate::{
    health::{AccountHealth, GoogleSetup},
    history::{
        activity::{DayQuality, DayUsage},
        report::{ActivityTracker, OtherLimit, UntrackedAccount, WeeklyActivity},
    },
    model::{
        AccountBucket, AccountOut, AppUpdateStatus, BridgeInfo, BridgeStatus, CloudProjectOption,
        DashboardSnapshot, LimitReset, LoginStart, LoginState, LoginStatus, Provider, ResetTarget,
        UsageFreshness, UsageSnapshot, UsageWindow, WindowKind,
    },
    pairing::{
        airgap::{AirgapExport, AirgapExportFrame, AirgapPreview},
        file_transfer::FilePreview,
        payload::SyncSummary,
        transport::QrMatrix,
        PairingHostInit, PairingStatus,
    },
    startup::StartupIssue,
    store::{alerts::UsageAlertSetting, settings::AppSettings},
    updater::AppUpdateProgress,
};
use usage_core::headline::{Headline, LongWindow};

const BINDINGS: &str = "../src/types.generated.ts";

/// `src/types.generated.ts`: one declaration per type the frontend receives, with the Rust doc
/// comments. Types used only inside these (such as `UsageWindow`) must be listed too.
fn generated_bindings() -> String {
    use ts_rs::{Config, TS};
    // Every integer the backend sends fits in a JavaScript number (counts, sizes, seconds).
    let config = Config::new().with_large_int("number");
    let mut out = String::from(
        "// Generated from the Rust types by `src-tauri/src/type_contract.rs`. Do not edit.\n\
         // Rewrite with `UPDATE_FIXTURES=1 cargo test --manifest-path src-tauri/Cargo.toml --lib type_contract`.\n",
    );
    macro_rules! declare {
        ($($ty:ty),* $(,)?) => {$(
            out.push('\n');
            if let Some(docs) = <$ty as TS>::docs() {
                out.push_str(&docs);
            }
            out.push_str("export ");
            out.push_str(&format_declaration(&<$ty as TS>::decl(&config)));
            out.push('\n');
        )*};
    }
    declare!(
        Provider,
        UsageFreshness,
        WindowKind,
        UsageWindow,
        ResetTarget,
        LimitReset,
        UsageSnapshot,
        AccountHealth,
        GoogleSetup,
        LongWindow,
        Headline,
        AccountOut<'static>,
        UsageAlertSetting,
        BridgeStatus,
        BridgeInfo,
        AccountBucket,
        DashboardSnapshot,
        DayQuality,
        DayUsage,
        ActivityTracker,
        OtherLimit,
        UntrackedAccount,
        WeeklyActivity,
        AppSettings,
        LoginStart,
        CloudProjectOption,
        LoginState,
        LoginStatus,
        AppUpdateStatus,
        AppUpdateProgress,
        SyncSummary,
        PairingHostInit,
        PairingStatus,
        StartupIssue,
        QrMatrix,
        AirgapExportFrame,
        AirgapExport,
        AirgapPreview,
        FilePreview,
        IncomingWatchInfo,
        ErrorCode,
        CommandError,
    );
    out
}

/// Puts each field of an object type on its own line. ts-rs writes a declaration on one line
/// (`{ id: string, label: string, }`), with doc comments on lines of their own; this indents
/// those by nesting depth and breaks after `{` and after each `,` that separates fields. Text
/// inside string literals, comments and `<...>` is copied as it is.
fn format_declaration(declaration: &str) -> String {
    const INDENT: &str = "  ";
    let chars: Vec<char> = declaration.chars().collect();
    let mut out = String::with_capacity(declaration.len() * 2);
    let (mut depth, mut angles) = (0usize, 0usize);
    let (mut in_string, mut in_comment) = (false, false);
    let newline = |out: &mut String, depth: usize| {
        let trimmed = out.trim_end_matches(' ').len();
        out.truncate(trimmed);
        out.push('\n');
        out.push_str(&INDENT.repeat(depth));
    };
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        let next = chars.get(index + 1).copied();
        index += 1;
        if in_comment {
            out.push(ch);
            if ch == '*' && next == Some('/') {
                out.push('/');
                index += 1;
                in_comment = false;
            } else if ch == '\n' {
                out.push_str(&INDENT.repeat(depth));
            }
            continue;
        }
        if in_string {
            out.push(ch);
            in_string = ch != '"';
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                out.push(ch);
            }
            '/' if next == Some('*') => {
                in_comment = true;
                out.push(ch);
            }
            '\n' => newline(&mut out, depth),
            '<' => {
                angles += 1;
                out.push(ch);
            }
            '>' => {
                angles = angles.saturating_sub(1);
                out.push(ch);
            }
            '{' if angles == 0 => {
                depth += 1;
                out.push(ch);
                newline(&mut out, depth);
                if next == Some(' ') {
                    index += 1;
                }
            }
            '}' if angles == 0 => {
                depth = depth.saturating_sub(1);
                newline(&mut out, depth);
                out.push(ch);
            }
            ',' if angles == 0 && depth > 0 => {
                out.push(ch);
                newline(&mut out, depth);
                if next == Some(' ') {
                    index += 1;
                }
            }
            _ => out.push(ch),
        }
    }
    // A doc comment ends with a line break that leaves an empty indented line before its field.
    out.lines()
        .filter(|line| !line.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

#[test]
fn declarations_are_formatted_one_field_per_line() {
    let declaration = "type A = { id: string, \n/**\n * Text, with { braces }.\n */\nlabels: Record<string, number>, inner: { name: \"a, b\", }, };";
    assert_eq!(
        format_declaration(declaration),
        [
            "type A = {",
            "  id: string,",
            "  /**",
            "   * Text, with { braces }.",
            "   */",
            "  labels: Record<string, number>,",
            "  inner: {",
            "    name: \"a, b\",",
            "  },",
            "};",
        ]
        .join("\n")
    );
}

#[test]
fn generated_bindings_are_current() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(BINDINGS);
    let current = generated_bindings();
    if std::env::var_os("UPDATE_FIXTURES").is_some() {
        std::fs::write(&path, &current).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        committed == current,
        "{} is out of date. Rewrite it with `UPDATE_FIXTURES=1 cargo test --lib type_contract`.",
        path.display()
    );
}
