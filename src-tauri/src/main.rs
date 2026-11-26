#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(windows)]
mod acrylic;
mod audio;
mod drag;
mod i18n;
mod icons;
mod layout;
mod material;
mod preferences;
mod private_directory;
mod request_log;
mod timer;
mod tool;
mod tool_ipc;
mod update;
mod usage;
mod widget;

use request_log::{Request, REQUEST_SCHEMA};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use timer::{Mode, Snapshot};

struct Clock(Arc<Mutex<tool::Controller>>);
struct Desktop(Mutex<DesktopData>);
struct DesktopData {
    qa: bool,
    show_reminders: bool,
    mini: bool,
    normal_geometry: Option<(
        LogicalSize<f64>,
        PhysicalPosition<i32>,
        bool,
        f64,
        PhysicalPosition<i32>,
    )>,
    reminder: Reminder,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Reminder {
    pending: bool,
    mode: Mode,
    revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopSnapshot {
    pinned: bool,
    mini: bool,
    visible: bool,
    decorated: bool,
    width: f64,
    height: f64,
    x: i32,
    y: i32,
    scale: f64,
    outer_width: u32,
    outer_height: u32,
    tray_available: bool,
    reminder: Reminder,
    reminder_visible: bool,
    reminder_x: i32,
    reminder_y: i32,
    reminder_width: u32,
    reminder_height: u32,
    work_x: i32,
    work_y: i32,
    work_width: u32,
    work_height: u32,
    focused: bool,
    widget: widget::Snapshot,
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    app.get_webview_window("main")
        .ok_or_else(|| "时钟窗口不可用，请重新打开应用。".into())
}

fn center_reminder(app: &AppHandle) -> tauri::Result<()> {
    layout::center_reminder(app)
}

fn show_main_unfocused(window: &WebviewWindow) -> tauri::Result<()> {
    // Keep Tao's visibility cache synchronized with the HWND. Its construction
    // no-focus marker is cleared even for initially hidden windows, so guard
    // the first show with its focusable flag and restore keyboard input after.
    #[cfg(windows)]
    {
        window.set_focusable(false)?;
        let shown = window.show();
        let restored = window.set_focusable(true);
        shown.and(restored)
    }
    #[cfg(not(windows))]
    window.show()
}

fn set_reminder_visible(window: &WebviewWindow, visible: bool) -> tauri::Result<()> {
    let qa = window
        .state::<Desktop>()
        .0
        .lock()
        .map(|data| data.qa)
        .unwrap_or(true);
    let muted = preferences::get_preferences(window.app_handle().clone())
        .map(|snapshot| snapshot.values.audio_muted)
        .unwrap_or(true);
    audio::mute(window, !visible || qa || muted);
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SetWindowPos, HWND_TOPMOST, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
            SWP_NOZORDER, SWP_SHOWWINDOW,
        };
        let hwnd = window.hwnd()?;
        let flags = SWP_NOACTIVATE
            | SWP_NOMOVE
            | SWP_NOSIZE
            | if visible {
                SWP_SHOWWINDOW
            } else {
                SWP_HIDEWINDOW | SWP_NOZORDER
            };
        // Read-only Tauri getters query the real HWND. Explicit flags avoid the runtime's activating show path.
        // SAFETY: hwnd belongs to this live WebviewWindow; no geometry pointers or external HWNDs are used.
        if unsafe { SetWindowPos(hwnd.0 as _, HWND_TOPMOST, 0, 0, 0, 0, flags) } == 0 {
            return Err(std::io::Error::last_os_error().into());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        if visible {
            window.show()
        } else {
            window.hide()
        }
    }
}

fn notify_completion(app: &AppHandle, mode: Mode) {
    usage::completed(app, mode);
    let (show, revision) = {
        let desktop = app.state::<Desktop>();
        let Ok(mut data) = desktop.0.lock() else {
            return;
        };
        data.reminder.pending = true;
        data.reminder.mode = mode;
        data.reminder.revision += 1;
        (data.show_reminders, data.reminder.revision)
    };
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        let current = handle
            .state::<Desktop>()
            .0
            .lock()
            .map(|data| data.reminder.pending && data.reminder.revision == revision)
            .unwrap_or(false);
        if !current {
            return;
        }
        if let Err(error) = preferences::sync_reminder(&handle) {
            eprintln!("Reminder appearance sync: {error}");
        }
        if let Err(error) = center_reminder(&handle) {
            eprintln!("Reminder positioning: {error}");
        }
        if show {
            if let Some(window) = handle.get_webview_window("reminder") {
                if let Err(error) = set_reminder_visible(&window, true) {
                    eprintln!("Reminder display: {error}");
                }
            }
        }
        if let Ok(state) = reminder_state(handle.clone()) {
            let _ = handle.emit("reminder-changed", state);
        }
    }) {
        eprintln!("Reminder dispatch: {error}");
    }
}

fn clock_snapshot(app: &AppHandle) -> Result<Snapshot, String> {
    let clock = app.state::<Clock>();
    let mut timer = clock.0.lock().map_err(|_| "计时服务暂时不可用。")?;
    timer.tick(Instant::now());
    let snapshot = timer.snapshot();
    let completed = timer.completion_pending.take();
    drop(timer);
    if let Some(mode) = completed {
        notify_completion(app, mode);
    }
    Ok(snapshot)
}

#[tauri::command]
fn snapshot(app: AppHandle) -> Result<Snapshot, String> {
    clock_snapshot(&app)
}

#[tauri::command]
fn action(app: AppHandle, action: String) -> Result<Snapshot, String> {
    let clock = app.state::<Clock>();
    let mut controller = clock.0.lock().map_err(|_| "计时服务暂时不可用。")?;
    let result = controller.gui_action(&action);
    let completed = controller.completion_pending.take();
    drop(controller);
    if let Some(mode) = completed {
        notify_completion(&app, mode);
    }
    result
}
fn tool_request(app: &AppHandle, value: Value, qa: bool) -> Value {
    let request: Request = match serde_json::from_value(value) {
        Ok(request) => request,
        Err(_) => {
            return json!({"ok":false,"error":{"code":"invalid_request","message":"Invalid tool request","outcome":"denied"}})
        }
    };
    if request.schema != REQUEST_SCHEMA {
        return json!({"ok":false,"error":{"code":"unsupported_version","outcome":"denied"}});
    }
    if request.operation == "operation" {
        return app
            .state::<Clock>()
            .0
            .lock()
            .map(|c| {
                c.operation(
                    request
                        .params
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or(""),
                )
            })
            .unwrap_or_else(|_| json!({"ok":false,"error":{"code":"unavailable"}}));
    }
    if qa && request.operation.starts_with("qa.") {
        // Tauri's synchronous window getters must run together on the UI thread.
        // Holding Desktop while a background getter waits for that thread deadlocks
        // against the ordinary UI poll of the same state.
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let handle = app.clone();
        if let Err(error) = app.run_on_main_thread(move || {
            let result = qa_request(&handle, &request);
            let _ = send.send(result);
        }) {
            return json!({"ok":false,"error":{"code":"qa_dispatch","message":error.to_string()}});
        }
        return receive
            .recv_timeout(Duration::from_secs(3))
            .unwrap_or_else(|_| json!({"ok":false,"error":{"code":"outcome_unknown"}}));
    }
    let clock = app.state::<Clock>();
    let Ok(mut controller) = clock.0.lock() else {
        return json!({"ok":false,"error":{"code":"unavailable"}});
    };
    let reply = controller.request(&request);
    let completed = controller.completion_pending.take();
    drop(controller);
    if let Some(mode) = completed {
        notify_completion(app, mode);
    }
    serde_json::to_value(reply)
        .unwrap_or_else(|_| json!({"ok":false,"error":{"code":"serialization"}}))
}

fn qa_request(app: &AppHandle, request: &Request) -> Value {
    let result = match request.operation.as_str() {
        "qa.system_theme" => request
            .params
            .get("theme")
            .and_then(Value::as_str)
            .ok_or_else(|| "theme required".to_owned())
            .and_then(|theme| material::set_qa_system_theme(app, theme))
            .map(|theme| json!({"theme":theme})),
        "qa.desktop" => desktop_state(app.clone()).map(|d| json!(d)),
        "qa.window" => request
            .params
            .get("action")
            .and_then(Value::as_str)
            .ok_or_else(|| "action required".to_owned())
            .and_then(|action| {
                if ["pin", "mini", "hide"].contains(&action) {
                    apply_desktop_action(app, action).map(|_| json!({}))
                } else {
                    Err("unsupported QA window action".into())
                }
            }),
        "qa.exit" => {
            app.exit(0);
            Ok(json!({"exiting":true}))
        }
        _ => Err("unsupported QA operation".into()),
    };
    return match result {
        Ok(data) => json!({"ok":true,"data":data}),
        Err(message) => json!({"ok":false,"error":{"code":"qa_failed","message":message}}),
    };
}

#[tauri::command]
fn reminder_state(app: AppHandle) -> Result<Reminder, String> {
    Ok(app
        .state::<Desktop>()
        .0
        .lock()
        .map_err(|_| "窗口状态不可用。")?
        .reminder
        .clone())
}

#[tauri::command]
fn dismiss_reminder(app: AppHandle) -> Result<(), String> {
    app.state::<Desktop>()
        .0
        .lock()
        .map_err(|_| "窗口状态不可用。")?
        .reminder
        .pending = false;
    if let Ok(state) = reminder_state(app.clone()) {
        let _ = app.emit("reminder-changed", state);
    }
    if let Some(window) = app.get_webview_window("reminder") {
        set_reminder_visible(&window, false).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn desktop_state(app: AppHandle) -> Result<DesktopSnapshot, String> {
    let main = main_window(&app)?;
    let reminder = app
        .get_webview_window("reminder")
        .ok_or("提醒窗口不可用。")?;
    let desktop = app.state::<Desktop>();
    let data = desktop.0.lock().map_err(|_| "窗口状态不可用。")?;
    let scale = main.scale_factor().map_err(|e| e.to_string())?;
    let size = main
        .inner_size()
        .map_err(|e| e.to_string())?
        .to_logical::<f64>(scale);
    let pos = reminder.outer_position().map_err(|e| e.to_string())?;
    let main_pos = main.outer_position().map_err(|e| e.to_string())?;
    let main_outer = main.outer_size().map_err(|e| e.to_string())?;
    let reminder_size = reminder.outer_size().map_err(|e| e.to_string())?;
    let monitor = main
        .current_monitor()
        .map_err(|e| e.to_string())?
        .ok_or("显示器暂时不可用。")?;
    let area = monitor.work_area();
    Ok(DesktopSnapshot {
        pinned: main.is_always_on_top().map_err(|e| e.to_string())?,
        mini: data.mini,
        visible: main.is_visible().map_err(|e| e.to_string())?,
        decorated: main.is_decorated().map_err(|e| e.to_string())?,
        width: size.width,
        height: size.height,
        x: main_pos.x,
        y: main_pos.y,
        scale,
        outer_width: main_outer.width,
        outer_height: main_outer.height,
        tray_available: app.tray_by_id("timer").is_some(),
        reminder: data.reminder.clone(),
        reminder_visible: reminder.is_visible().map_err(|e| e.to_string())?,
        reminder_x: pos.x,
        reminder_y: pos.y,
        reminder_width: reminder_size.width,
        reminder_height: reminder_size.height,
        work_x: area.position.x,
        work_y: area.position.y,
        work_width: area.size.width,
        work_height: area.size.height,
        focused: main.is_focused().unwrap_or(false),
        widget: widget::snapshot(&main)?,
    })
}

fn apply_desktop_action(app: &AppHandle, action: &str) -> Result<(), String> {
    if action == "quit" {
        for label in ["main", "reminder"] {
            if let Some(window) = app.get_webview_window(label) {
                audio::mute(&window, true);
            }
        }
    }
    let main = main_window(app)?;
    let desktop = app.state::<Desktop>();
    let mut data = desktop.0.lock().map_err(|_| "窗口状态不可用。")?;
    if action == "pin" && !data.mini {
        let state = app.state::<preferences::State>();
        let mut store = state.0.lock().map_err(|_| "设置暂时不可用。")?;
        let previous = main.is_always_on_top().map_err(|e| e.to_string())?;
        let mut next = store.values.clone();
        next.always_on_top = !previous;
        main.set_always_on_top(!previous)
            .map_err(|e| e.to_string())?;
        if let Err(error) = store.save(next) {
            let _ = main.set_always_on_top(previous);
            return Err(format!("置顶设置未保存：{error}"));
        }
        return Ok(());
    }
    let mut operation = || -> tauri::Result<()> {
        match action {
            "pin" => main
                .is_always_on_top()
                .and_then(|pinned| main.set_always_on_top(!pinned)),
            "mini" => {
                if !data.mini {
                    data.normal_geometry = Some((
                        main.inner_size()?.to_logical(main.scale_factor()?),
                        main.outer_position()?,
                        main.is_always_on_top()?,
                        main.scale_factor()?,
                        main.current_monitor()?
                            .map(|m| *m.position())
                            .unwrap_or_default(),
                    ));
                    main.set_resizable(false)?;
                    layout::resize(&main, LogicalSize::new(280.0, 80.0), true)?;
                    main.set_always_on_top(true)?;
                    if let Some(monitor) = main.current_monitor()? {
                        let area = monitor.work_area();
                        let size = main.outer_size()?;
                        let margin = (24.0 * monitor.scale_factor()).round() as i32;
                        main.set_position(PhysicalPosition::new(
                            (area.position.x + area.size.width as i32 - size.width as i32 - margin)
                                .max(area.position.x),
                            (area.position.y + area.size.height as i32
                                - size.height as i32
                                - margin)
                                .max(area.position.y),
                        ))?;
                    }
                    data.mini = true;
                } else {
                    main.set_resizable(true)?;
                    if let Some((size, pos, pinned, scale, monitor)) = data.normal_geometry {
                        layout::resize(&main, size, false)?;
                        let same_monitor = main.current_monitor()?.is_some_and(|m| {
                            *m.position() == monitor && (m.scale_factor() - scale).abs() < 0.01
                        });
                        if same_monitor {
                            main.set_position(pos)?;
                        }
                        main.set_always_on_top(pinned)?;
                    }
                    data.mini = false;
                }
                Ok(())
            }
            "minimize" => main.minimize(),
            "hide" => main.hide(),
            "show" => {
                if data.qa && !std::env::args().any(|a| a == "--qa-cua") {
                    Ok(())
                } else {
                    main.unminimize().and_then(|_| show_main_unfocused(&main))
                }
            }
            "quit" => {
                app.exit(0);
                Ok(())
            }
            _ => unreachable!("window action validated before dispatch"),
        }
    };
    if !["pin", "mini", "minimize", "hide", "show", "quit"].contains(&action) {
        return Err("不支持的窗口操作。".into());
    }
    let result = operation().map_err(|e| e.to_string());
    drop(operation);
    drop(data);
    result?;
    if action != "quit" {
        widget::refresh(app)?;
    }
    if action == "mini" {
        widget::settle(app, true)?;
    }
    Ok(())
}

#[tauri::command]
fn desktop_action(app: AppHandle, action: String) -> Result<Option<DesktopSnapshot>, String> {
    apply_desktop_action(&app, &action)?;
    if action == "mini" {
        desktop_state(app).map(Some)
    } else {
        Ok(None)
    }
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if let Some(code) = update::dispatch(&args) {
        std::process::exit(code);
    }
    // Dispatch before Tauri and single-instance hooks: CLI never shows a window.
    if let Some(index) = args.iter().position(|a| a == "--tool-request") {
        let result = args
            .get(index + 1)
            .ok_or_else(|| "JSON request required".to_owned())
            .and_then(|text| serde_json::from_str::<Value>(text).map_err(|e| e.to_string()))
            .and_then(|request| {
                tool_ipc::pipe_name(args.iter().any(|a| a == "--tool-qa"))
                    .and_then(|name| tool_ipc::call(&name, &request))
            });
        match result {
            Ok(reply) => {
                println!("{}", reply);
                std::process::exit(if reply.get("ok") == Some(&Value::Bool(true)) {
                    0
                } else {
                    1
                });
            }
            Err(message) => {
                println!(
                    "{}",
                    json!({"ok":false,"error":{"code":"tool_unavailable","message":message,"outcome":"unknown"}})
                );
                std::process::exit(2);
            }
        }
    }
    let cua = args.iter().any(|a| a == "--qa-cua");
    let qa = cua || args.iter().any(|a| a == "--qa-hidden");
    let seconds = if qa {
        args.iter()
            .find_map(|a| {
                a.strip_prefix("--qa-seconds=")
                    .and_then(|s| s.parse::<u64>().ok())
            })
            .filter(|s| (1..=60).contains(s))
    } else {
        None
    };
    let mut context = tauri::generate_context!();
    if qa {
        context.config_mut().identifier.push_str(".toolqa");
    }
    tauri::Builder::default()
        .manage(drag::State::default())
        .manage(widget::State::default())
        .manage(icons::State::default())
        .manage(i18n::State::default())
        .manage(material::State::default())
        .manage(layout::State::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().any(|a| a == "--start-in-tray") {
                return;
            }
            if app
                .try_state::<Desktop>()
                .and_then(|d| d.0.lock().ok().map(|s| s.qa))
                .unwrap_or(false)
            {
                return;
            }
            let _ = apply_desktop_action(app, "show");
        }))
        .manage(Desktop(Mutex::new(DesktopData {
            qa,
            show_reminders: !qa || args.iter().any(|a| a == "--qa-show-reminders"),
            mini: false,
            normal_geometry: None,
            reminder: Reminder {
                pending: false,
                mode: Mode::Focus,
                revision: 0,
            },
        })))
        .invoke_handler(tauri::generate_handler![
            app_version,
            snapshot,
            action,
            desktop_state,
            desktop_action,
            reminder_state,
            dismiss_reminder,
            material::set_appearance,
            material::appearance_state,
            material::system_theme,
            i18n::language_state,
            icons::icon_state,
            drag::drag_geometry,
            drag::drag_to,
            drag::drag_update,
            drag::native_drag,
            usage::usage_snapshot,
            widget::widget_activity,
            widget::widget_menu,
            preferences::get_preferences,
            preferences::set_preferences,
            preferences::set_reminder_audio,
            audio::audio_window_state
        ])
        .on_menu_event(|app, event| {
            if event.id.as_ref().starts_with("widget.") {
                if let Err(error) = widget::menu_action(app, event.id.as_ref()) {
                    eprintln!("Widget menu: {error}");
                }
            }
        })
        .on_window_event(|window, event| {
            if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                match event {
                    WindowEvent::ScaleFactorChanged { .. } => layout::changed(&webview, true),
                    WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                        layout::changed(&webview, false)
                    }
                    _ => {}
                }
            }
            if window.label() == "main" && matches!(event, WindowEvent::ThemeChanged(_)) {
                if let Ok(theme) = material::system_theme(window.app_handle().clone()) {
                    let _ = window.app_handle().emit("system-theme-changed", theme);
                }
            }
            if window.label() == "main" && matches!(event, WindowEvent::Focused(_)) {
                let _ = widget::refresh(window.app_handle());
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if window.label() == "reminder" {
                    let _ = dismiss_reminder(window.app_handle().clone());
                } else {
                    let _ = window.hide();
                }
            }
        })
        .setup(move |app| {
            // Tauri can defer setup until run(), where a setup error is promoted
            // to a panic. Report it here while the original error is available.
            let result: Result<(), Box<dyn std::error::Error>> = (|| {
                let directory = args
                    .iter()
                    .find_map(|a| a.strip_prefix("--tool-data-dir="))
                    .map(std::path::PathBuf::from)
                    .unwrap_or(app.path().app_data_dir()?.join(if qa {
                        "tool-integration-qa"
                    } else {
                        "tool-integration"
                    }));
                let default_root = !args.iter().any(|a| a.starts_with("--tool-data-dir="));
                let simulate_legacy_owner =
                    qa && args.iter().any(|a| a == "--qa-legacy-empty-owner");
                let controller = tool::Controller::open_with_recovery(
                    seconds,
                    directory,
                    qa,
                    default_root || simulate_legacy_owner,
                    simulate_legacy_owner,
                )
                .map_err(|e| std::io::Error::other(e.message))?;
                app.manage(Clock(Arc::new(Mutex::new(controller))));
                let preference_path = if qa {
                    args.iter()
                        .find_map(|a| a.strip_prefix("--qa-preferences-file="))
                        .map(std::path::PathBuf::from)
                        .unwrap_or(std::env::current_dir()?.join("tmp/preferences-qa.json"))
                } else {
                    app.path().app_data_dir()?.join("preferences.json")
                };
                if !preference_path.is_absolute() {
                    return Err(std::io::Error::other("设置文件路径必须是绝对路径。").into());
                }
                app.manage(usage::State(Mutex::new(usage::Store::open(
                    preference_path.with_file_name("usage.json"),
                ))));
                let preference_store = preferences::Store::open(preference_path);
                let initial_preferences = preference_store.values.clone();
                app.manage(preferences::State(Mutex::new(preference_store)));
                material::watch_system(app.handle().clone());
                let handle = app.handle().clone();
                tool_ipc::serve(
                    tool_ipc::pipe_name(qa).map_err(std::io::Error::other)?,
                    move |request| tool_request(&handle, request, qa),
                )
                .map_err(std::io::Error::other)?;
                let mut main = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                    .title("番茄时钟")
                    .decorations(false)
                    .transparent(true)
                    .background_color(tauri::window::Color(0, 0, 0, 0))
                    .inner_size(400.0, 580.0)
                    .min_inner_size(360.0, 540.0)
                    .focused(false)
                    .zoom_hotkeys_enabled(false)
                    .additional_browser_args("--autoplay-policy=no-user-gesture-required")
                    .always_on_top(initial_preferences.always_on_top)
                    .visible(false)
                    .devtools(qa);
                let mut reminder = WebviewWindowBuilder::new(
                    app,
                    "reminder",
                    WebviewUrl::App("reminder.html".into()),
                )
                .title("本段计时完成")
                .decorations(false)
                .transparent(true)
                .background_color(tauri::window::Color(0, 0, 0, 0))
                .inner_size(360.0, 420.0)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .zoom_hotkeys_enabled(false)
                .additional_browser_args("--autoplay-policy=no-user-gesture-required")
                .visible(false)
                .devtools(qa);
                if qa {
                    main = main.initialization_script("window.__POMODORO_SILENT_AUDIO__ = true;");
                    reminder =
                        reminder.initialization_script("window.__POMODORO_SILENT_AUDIO__ = true;");
                    let dir = std::env::current_dir()?.join("tmp/qa-webview-v5");
                    main = main.data_directory(dir.clone());
                    reminder = reminder.data_directory(dir);
                }
                let main = main
                    .icon(icons::image(initial_preferences.icon, false))?
                    .build()?;
                let reminder = reminder
                    .icon(icons::image(initial_preferences.icon, false))?
                    .build()?;
                main.set_zoom(1.0)?;
                reminder.set_zoom(1.0)?;
                audio::mute(&main, qa || initial_preferences.audio_muted);
                audio::mute(&reminder, true);
                drag::install(&main).map_err(std::io::Error::other)?;
                layout::resize(&main, LogicalSize::new(400.0, 580.0), false)?;
                material::set_corners(app.handle(), initial_preferences.corner_radius)
                    .map_err(std::io::Error::other)?;
                preferences::place(&main, initial_preferences.position)
                    .map_err(std::io::Error::other)?;
                center_reminder(app.handle())?;
                let items = [
                    MenuItem::with_id(app, "show", "显示番茄时钟", true, None::<&str>)?,
                    MenuItem::with_id(app, "toggle", "开始 / 暂停", true, None::<&str>)?,
                    MenuItem::with_id(app, "reset", "重置本段", true, None::<&str>)?,
                    MenuItem::with_id(app, "pin", "置顶 / 取消置顶", true, None::<&str>)?,
                    MenuItem::with_id(app, "mini", "切换小悬浮窗", true, None::<&str>)?,
                    MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?,
                ];
                let refs: Vec<&dyn tauri::menu::IsMenuItem<_>> = items
                    .iter()
                    .map(|i| i as &dyn tauri::menu::IsMenuItem<_>)
                    .collect();
                let menu = Menu::with_items(app, &refs)?;
                let tray = TrayIconBuilder::with_id("timer")
                    .icon(icons::image(initial_preferences.icon, true))
                    .tooltip("番茄时钟")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| {
                        if event.id.as_ref().starts_with("widget.") {
                            return;
                        }
                        let result = match event.id.as_ref() {
                            "toggle" | "reset" => {
                                action(app.clone(), event.id.as_ref().to_string()).map(|_| ())
                            }
                            id => apply_desktop_action(app, id),
                        };
                        if let Err(error) = result {
                            eprintln!("Tray action: {error}");
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        if matches!(
                            event,
                            TrayIconEvent::Click {
                                button: MouseButton::Left,
                                button_state: MouseButtonState::Up,
                                ..
                            }
                        ) {
                            let _ = apply_desktop_action(tray.app_handle(), "show");
                        }
                    })
                    .build(app)?;
                i18n::refresh(app.handle()).map_err(std::io::Error::other)?;
                if qa {
                    tray.set_visible(false)?;
                }
                icons::apply(app.handle(), initial_preferences.icon)
                    .map_err(std::io::Error::other)?;
                if (!qa || cua) && !args.iter().any(|a| a == "--start-in-tray") {
                    show_main_unfocused(&main)?;
                }
                let handle = app.handle().clone();
                let clock = app.state::<Clock>().0.clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_millis(100));
                    let Ok(mut controller) = clock.lock() else {
                        break;
                    };
                    controller.tick(Instant::now());
                    let completed = controller.completion_pending.take();
                    drop(controller);
                    if let Some(mode) = completed {
                        notify_completion(&handle, mode);
                    }
                });
                Ok(())
            })();
            if let Err(error) = result {
                startup_failure(&error.to_string(), qa);
            }
            Ok(())
        })
        .build(context)
        .unwrap_or_else(|error| startup_failure(&error.to_string(), qa))
        .run(|_, _| {});
}

fn startup_failure(error: &str, qa: bool) -> ! {
    let directory = if qa {
        std::env::current_dir().ok()
    } else {
        std::env::var_os("LOCALAPPDATA")
            .map(|path| std::path::PathBuf::from(path).join("local.cosweel.pomodoro"))
    };
    let log = directory.and_then(|directory| {
        std::fs::create_dir_all(&directory).ok()?;
        let path = directory.join("startup-error.log");
        std::fs::write(&path, format!("番茄时钟启动失败\n{error}\n")).ok()?;
        Some(path)
    });
    eprintln!("番茄时钟启动失败：{error}");
    #[cfg(windows)]
    if !qa {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
        let details = log
            .map(|path| format!("\n\n错误记录：{}", path.display()))
            .unwrap_or_default();
        let message: Vec<u16> = format!("番茄时钟未能启动。\n{error}{details}\0")
            .encode_utf16()
            .collect();
        let title: Vec<u16> = "番茄时钟 · 启动失败\0".encode_utf16().collect();
        // SAFETY: nul-terminated strings remain alive for the modal call.
        unsafe {
            MessageBoxW(
                std::ptr::null_mut(),
                message.as_ptr(),
                title.as_ptr(),
                MB_OK | MB_ICONERROR,
            );
        }
    }
    std::process::exit(1)
}
