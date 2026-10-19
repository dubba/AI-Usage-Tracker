//! Start-at-login on Windows. The autostart plugin (through `auto-launch`)
//! writes the `Run` registry value as `{exe} {args}` without quotes. The install
//! path contains spaces (`…\AI Usage Tracker\AI Usage Tracker.exe`), and Windows
//! splits an unquoted command line at spaces, trying each prefix as a program
//! first. This rewrites the plugin's own entry with the path quoted.

/// Arguments the app is started with at login.
#[cfg_attr(mobile, allow(dead_code))]
pub(crate) const AUTOSTART_ARGS: &[&str] = &["--hidden"];

/// The command line for the Windows `Run` value: the executable quoted so it
/// cannot be split at a space, then the arguments. Windows paths cannot contain
/// `"`, so quoting the path is enough.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub(crate) fn windows_run_command(exe: &str, args: &[&str]) -> String {
    let mut command = format!("\"{exe}\"");
    for arg in args {
        command.push(' ');
        command.push_str(arg);
    }
    command
}

/// Quotes the executable path in the autostart entry, if there is one. Called
/// after the plugin enables autostart and once at startup for entries written
/// by earlier versions. It never creates the entry, so it cannot turn
/// autostart on, and a failure leaves the plugin's (working) entry in place.
#[cfg(windows)]
pub(crate) fn quote_windows_run_value(app_name: &str) {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE};
    use winreg::RegKey;

    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let desired = windows_run_command(&exe.display().to_string(), AUTOSTART_ARGS);
    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
        "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run",
        KEY_READ | KEY_SET_VALUE,
    ) else {
        return;
    };
    if let Ok(current) = key.get_value::<String, _>(app_name) {
        if current != desired && key.set_value(app_name, &desired).is_err() {
            crate::diagnostics::warn(
                "Could not quote the start-at-login command; the app still starts at login.",
            );
        }
    }
}

#[cfg(not(windows))]
#[cfg_attr(mobile, allow(dead_code))]
pub(crate) fn quote_windows_run_value(_app_name: &str) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_windows_autostart_command_quotes_a_path_with_spaces() {
        assert_eq!(
            windows_run_command(
                r"C:\Users\me\AppData\Local\AI Usage Tracker\AI Usage Tracker.exe",
                AUTOSTART_ARGS,
            ),
            r#""C:\Users\me\AppData\Local\AI Usage Tracker\AI Usage Tracker.exe" --hidden"#
        );
        assert_eq!(
            windows_run_command(r"C:\Program Files\App\App.exe", &[]),
            r#""C:\Program Files\App\App.exe""#
        );
    }
}
