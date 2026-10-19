//! The main window's desktop behavior: restoring its saved size and position, hiding to the
//! tray instead of quitting when closed, and the tray icon with its menu.

#[cfg(desktop)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    WindowEvent,
};
use tauri::{AppHandle, Manager};
#[cfg(desktop)]
use tauri_plugin_window_state::{AppHandleExt, StateFlags, WindowExt};

#[cfg(desktop)]
pub(crate) const SAVED_WINDOW_STATE: StateFlags = StateFlags::from_bits_truncate(
    StateFlags::SIZE.bits()
        | StateFlags::POSITION.bits()
        | StateFlags::MAXIMIZED.bits()
        | StateFlags::FULLSCREEN.bits(),
);

pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        #[cfg(desktop)]
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Restores the saved window state and makes closing the window hide it to the tray.
#[cfg(desktop)]
pub(crate) fn setup_main_window(app: &tauri::App) {
    if let Some(window) = app.get_webview_window("main") {
        let start_hidden = std::env::args().any(|argument| argument == "--hidden");
        if let Some(icon) = app.default_window_icon() {
            let _ = window.set_icon(icon.clone());
        }
        let _ = window.restore_state(SAVED_WINDOW_STATE);
        paint_desktop_title_bar(&window);
        if !start_hidden {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        paint_desktop_title_bar(&window);

        let window_for_event = window.clone();
        window.on_window_event(move |event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window_for_event
                    .app_handle()
                    .save_window_state(SAVED_WINDOW_STATE);
                let _ = window_for_event.hide();
            }
            WindowEvent::Focused(_) | WindowEvent::ThemeChanged(_) => {
                paint_desktop_title_bar(&window_for_event);
            }
            _ => {}
        });
    }
}

/// Adds the tray icon and its Open / Quit menu.
#[cfg(desktop)]
pub(crate) fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_label = format!("Open {}", app.package_info().name);
    let show = MenuItem::with_id(app, "show", show_label, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut tray = TrayIconBuilder::new()
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                let _ = app.save_window_state(SAVED_WINDOW_STATE);
                crate::commands::bridge::remember_api_integration_window_size(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            }
            | TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => show_main_window(tray.app_handle()),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Same purple as the Android status bar overlay (`--purple-fill` in `src/styles/tokens.css`; `src/styles/purple-tokens.test.ts` checks they match).
const TITLE_BAR_PURPLE_RGB: (u8, u8, u8) = (0x6d, 0x3b, 0xd7);

#[cfg(windows)]
const WINDOWS_CAPTION_TEXT_WHITE: u32 = 0x00ff_ffff;

/// COLORREF is 0x00BBGGRR.
#[cfg(any(windows, test))]
fn windows_caption_colorref() -> u32 {
    let (r, g, b) = TITLE_BAR_PURPLE_RGB;
    u32::from(r) | (u32::from(g) << 8) | (u32::from(b) << 16)
}

#[cfg(target_os = "macos")]
use objc2::runtime::{AnyClass, AnyObject};

/// Paint the native title bar the Android status-bar purple.
#[cfg(desktop)]
fn paint_desktop_title_bar(window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    paint_macos_title_bar(window);
    #[cfg(windows)]
    paint_windows_title_bar(window);
    #[cfg(not(any(target_os = "macos", windows)))]
    let _ = window;
}

#[cfg(target_os = "macos")]
fn paint_macos_title_bar(window: &tauri::WebviewWindow) {
    use objc2::msg_send;

    let Ok(ptr) = window.ns_window() else {
        return;
    };
    if ptr.is_null() {
        return;
    }
    unsafe {
        let Some(cls) = AnyClass::get(c"NSColor") else {
            return;
        };
        let (r, g, b) = TITLE_BAR_PURPLE_RGB;
        let purple: *mut AnyObject = msg_send![
            cls,
            colorWithRed: f64::from(r) / 255.0,
            green: f64::from(g) / 255.0,
            blue: f64::from(b) / 255.0,
            alpha: 1.0
        ];
        if purple.is_null() {
            return;
        }
        let black: *mut AnyObject = msg_send![cls, blackColor];
        if black.is_null() {
            return;
        }
        let ns_window = ptr as *mut AnyObject;
        // Transparent title bars show this color in the whole window until the
        // webview paints. Keep it black; purple lives on the titlebar views.
        let _: () = msg_send![ns_window, setBackgroundColor: black];
        paint_macos_titlebar_fill(ns_window, purple);
        paint_macos_title_white(ns_window);
    }
}

/// `NSThemeFrame` is the whole window, so only views whose class name contains
/// "titlebar" get the purple fill.
#[cfg(any(target_os = "macos", test))]
fn is_titlebar_chrome_class(name: &str) -> bool {
    name.to_ascii_lowercase().contains("titlebar")
}

#[cfg(target_os = "macos")]
unsafe fn nsobject_class_name(obj: *mut AnyObject) -> Option<String> {
    use objc2::msg_send;

    let name: *mut AnyObject = msg_send![obj, className];
    if name.is_null() {
        return None;
    }
    let utf8: *const i8 = msg_send![name, UTF8String];
    if utf8.is_null() {
        return None;
    }
    Some(
        std::ffi::CStr::from_ptr(utf8)
            .to_string_lossy()
            .into_owned(),
    )
}

#[cfg(target_os = "macos")]
unsafe fn paint_macos_titlebar_fill(ns_window: *mut AnyObject, purple: *mut AnyObject) {
    use objc2::msg_send;
    use objc2::runtime::Bool;

    let close_btn: *mut AnyObject = msg_send![ns_window, standardWindowButton: 0isize];
    if close_btn.is_null() {
        return;
    }
    let cg_color: *const AnyObject = msg_send![purple, CGColor];
    if cg_color.is_null() {
        return;
    }
    let mut view: *mut AnyObject = msg_send![close_btn, superview];
    while !view.is_null() {
        let Some(name) = nsobject_class_name(view) else {
            break;
        };
        if !is_titlebar_chrome_class(&name) {
            break;
        }
        let _: () = msg_send![view, setWantsLayer: Bool::YES];
        let layer: *mut AnyObject = msg_send![view, layer];
        if !layer.is_null() {
            let _: () = msg_send![layer, setBackgroundColor: cg_color];
        }
        view = msg_send![view, superview];
    }
}

/// AppKit draws the title as an `NSTextField` and otherwise uses a dim system gray.
#[cfg(target_os = "macos")]
unsafe fn paint_macos_title_white(ns_window: *mut AnyObject) {
    use objc2::msg_send;

    let Some(color_cls) = AnyClass::get(c"NSColor") else {
        return;
    };
    let Some(text_cls) = AnyClass::get(c"NSTextField") else {
        return;
    };
    let white: *mut AnyObject = msg_send![color_cls, whiteColor];
    if white.is_null() {
        return;
    }
    // NSWindowCloseButton. Walk a level up so we cover the title, not only the
    // traffic-light cluster.
    let close_btn: *mut AnyObject = msg_send![ns_window, standardWindowButton: 0isize];
    if close_btn.is_null() {
        return;
    }
    let parent: *mut AnyObject = msg_send![close_btn, superview];
    if parent.is_null() {
        return;
    }
    let grandparent: *mut AnyObject = msg_send![parent, superview];
    let root = if grandparent.is_null() {
        parent
    } else {
        grandparent
    };
    color_ns_text_fields(root, text_cls, white);
}

#[cfg(target_os = "macos")]
unsafe fn color_ns_text_fields(
    view: *mut AnyObject,
    text_cls: &objc2::runtime::AnyClass,
    white: *mut AnyObject,
) {
    use objc2::msg_send;

    if view.is_null() {
        return;
    }
    let is_text: bool = msg_send![view, isKindOfClass: text_cls];
    if is_text {
        let _: () = msg_send![view, setTextColor: white];
        let cell: *mut AnyObject = msg_send![view, cell];
        if !cell.is_null() {
            // NSBackgroundStyleEmphasized: light content on a dark bar.
            let _: () = msg_send![cell, setBackgroundStyle: 1isize];
            let _: () = msg_send![cell, setTextColor: white];
        }
    }
    let subviews: *mut AnyObject = msg_send![view, subviews];
    if subviews.is_null() {
        return;
    }
    let count: usize = msg_send![subviews, count];
    for i in 0..count {
        let child: *mut AnyObject = msg_send![subviews, objectAtIndex: i];
        color_ns_text_fields(child, text_cls, white);
    }
}

#[cfg(windows)]
fn paint_windows_title_bar(window: &tauri::WebviewWindow) {
    const DWMWA_CAPTION_COLOR: u32 = 35;
    const DWMWA_TEXT_COLOR: u32 = 36;

    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: isize,
            attribute: u32,
            value: *const std::ffi::c_void,
            size: u32,
        ) -> i32;
    }

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    let caption = windows_caption_colorref();
    unsafe {
        let handle = hwnd.0 as isize;
        let _ = DwmSetWindowAttribute(
            handle,
            DWMWA_CAPTION_COLOR,
            (&caption as *const u32).cast(),
            4,
        );
        let _ = DwmSetWindowAttribute(
            handle,
            DWMWA_TEXT_COLOR,
            (&WINDOWS_CAPTION_TEXT_WHITE as *const u32).cast(),
            4,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::{is_titlebar_chrome_class, windows_caption_colorref};

    #[test]
    fn titlebar_chrome_class_matches_appkit_titlebar_views() {
        assert!(is_titlebar_chrome_class("NSTitlebarView"));
        assert!(is_titlebar_chrome_class("NSTitlebarContainerView"));
        assert!(is_titlebar_chrome_class("_NSTitlebarDecorationView"));
        assert!(!is_titlebar_chrome_class("NSThemeFrame"));
        assert!(!is_titlebar_chrome_class("WKWebView"));
        assert!(!is_titlebar_chrome_class("NSView"));
    }

    #[test]
    fn windows_caption_color_is_status_bar_purple() {
        let color = windows_caption_colorref();
        assert_eq!(color & 0xff, 0x6d, "red");
        assert_eq!((color >> 8) & 0xff, 0x3b, "green");
        assert_eq!((color >> 16) & 0xff, 0xd7, "blue");
    }
}
