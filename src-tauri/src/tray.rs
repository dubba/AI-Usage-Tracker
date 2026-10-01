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
        if !start_hidden {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }

        let window_for_event = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window_for_event
                    .app_handle()
                    .save_window_state(SAVED_WINDOW_STATE);
                let _ = window_for_event.hide();
            }
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
