use serde::Serialize;
use std::sync::Mutex;
use tauri::{
    menu::{CheckMenuItem, ContextMenu, Menu, MenuItem, PredefinedMenuItem},
    AppHandle, Manager, WebviewWindow,
};

#[derive(Default)]
pub struct State(pub Mutex<Runtime>);
#[derive(Default)]
pub struct Runtime {
    inside: bool,
    dragging: bool,
    owns_layered: bool,
    original_attributes: Option<(u32, u8, u32)>,
    dimmed: bool,
    shell_original: Option<isize>,
    taskbar_skipped: Option<bool>,
    content_opacity: u8,
    acrylic: bool,
    mini: bool,
}
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Frame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub effective_opacity: u8,
    pub native_opacity: u8,
    pub content_opacity: u8,
    pub acrylic: bool,
    pub layered: bool,
    pub dimmed: bool,
    pub dragging: bool,
    pub focused: bool,
    pub pointer_inside: bool,
    pub frame: Frame,
    pub tool_window: bool,
    pub app_window: bool,
}

fn shell_flags(window: &WebviewWindow) -> Result<(bool, bool), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, GWL_EXSTYLE, WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
        };
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        let flags = unsafe { GetWindowLongPtrW(hwnd.0 as _, GWL_EXSTYLE) };
        Ok((
            flags & WS_EX_TOOLWINDOW as isize != 0,
            flags & WS_EX_APPWINDOW as isize != 0,
        ))
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok((false, true))
    }
}

fn shell_mode(app: &AppHandle, window: &WebviewWindow, mini: bool) -> Result<(), String> {
    let visible = window.is_visible().map_err(|error| error.to_string())?;
    let skip = mini || !visible;
    let state = app.state::<State>();
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{GetLastError, SetLastError},
            UI::WindowsAndMessaging::{
                GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, SWP_FRAMECHANGED,
                SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOSIZE, SWP_NOZORDER,
                WS_EX_APPWINDOW, WS_EX_TOOLWINDOW,
            },
        };
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        let current = unsafe { GetWindowLongPtrW(hwnd.0 as _, GWL_EXSTYLE) };
        let mask = (WS_EX_TOOLWINDOW | WS_EX_APPWINDOW) as isize;
        let (original, previous_skip) = {
            let mut runtime = state.0.lock().map_err(|_| "小窗状态不可用。")?;
            if mini && runtime.shell_original.is_none() {
                runtime.shell_original = Some(current & mask);
            }
            (
                runtime.shell_original.unwrap_or(current & mask),
                runtime.taskbar_skipped,
            )
        };
        let next = (current & !mask)
            | if mini {
                WS_EX_TOOLWINDOW as isize
            } else {
                original
            };
        let changed = next != current;
        if changed {
            // SAFETY: change only shell eligibility bits on our HWND, preserving opacity/topmost flags.
            unsafe {
                SetLastError(0);
                SetWindowLongPtrW(hwnd.0 as _, GWL_EXSTYLE, next);
            }
            if unsafe { GetLastError() } != 0 {
                return Err(std::io::Error::last_os_error().to_string());
            }
            if unsafe {
                SetWindowPos(
                    hwnd.0 as _,
                    std::ptr::null_mut(),
                    0,
                    0,
                    0,
                    0,
                    SWP_FRAMECHANGED
                        | SWP_NOMOVE
                        | SWP_NOSIZE
                        | SWP_NOZORDER
                        | SWP_NOACTIVATE
                        | SWP_NOOWNERZORDER,
                )
            } == 0
            {
                let error = std::io::Error::last_os_error().to_string();
                unsafe {
                    SetWindowLongPtrW(hwnd.0 as _, GWL_EXSTYLE, current);
                };
                return Err(error);
            }
        }
        if changed || previous_skip != Some(skip) && (mini || previous_skip.is_some()) {
            window
                .set_skip_taskbar(skip)
                .map_err(|error| error.to_string())?;
            state
                .0
                .lock()
                .map_err(|_| "小窗状态不可用。")?
                .taskbar_skipped = Some(skip);
        }
        if !mini {
            state
                .0
                .lock()
                .map_err(|_| "小窗状态不可用。")?
                .shell_original = None;
        }
    }
    #[cfg(not(windows))]
    {
        let _ = state;
        window
            .set_skip_taskbar(mini)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

pub fn frame(window: &WebviewWindow) -> Result<Frame, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::RECT,
            Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_EXTENDED_FRAME_BOUNDS},
        };
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let mut rect: RECT = unsafe { std::mem::zeroed() };
        // SAFETY: owned HWND; correctly sized physical-screen rectangle.
        if unsafe {
            DwmGetWindowAttribute(
                hwnd.0 as _,
                DWMWA_EXTENDED_FRAME_BOUNDS as u32,
                (&mut rect as *mut RECT).cast(),
                size_of::<RECT>() as u32,
            )
        } >= 0
            && rect.right > rect.left
            && rect.bottom > rect.top
        {
            return Ok(Frame {
                x: rect.left,
                y: rect.top,
                width: (rect.right - rect.left) as u32,
                height: (rect.bottom - rect.top) as u32,
            });
        }
    }
    let p = window.outer_position().map_err(|e| e.to_string())?;
    let s = window.outer_size().map_err(|e| e.to_string())?;
    Ok(Frame {
        x: p.x,
        y: p.y,
        width: s.width,
        height: s.height,
    })
}

pub fn move_to(window: &WebviewWindow, x: i32, y: i32) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowRect, SetWindowPos, SWP_NOACTIVATE, SWP_NOOWNERZORDER, SWP_NOSENDCHANGING,
            SWP_NOSIZE, SWP_NOZORDER,
        };
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let mut rect: windows_sys::Win32::Foundation::RECT = unsafe { std::mem::zeroed() };
        if unsafe { GetWindowRect(hwnd.0 as _, &mut rect) } != 0 && rect.left == x && rect.top == y
        {
            return Ok(());
        }
        // Move our own window immediately, preserving focus, dimensions and topmost state.
        if unsafe {
            SetWindowPos(
                hwnd.0 as _,
                std::ptr::null_mut(),
                x,
                y,
                0,
                0,
                SWP_NOACTIVATE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    window
        .set_position(tauri::PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

fn snapped(frame: Frame, area: Frame, threshold: i32, dock: bool) -> (i32, i32) {
    let right = (area.x + area.width as i32 - frame.width as i32).max(area.x);
    let bottom = (area.y + area.height as i32 - frame.height as i32).max(area.y);
    if dock {
        return (right, bottom);
    }
    let mut x = frame.x.clamp(area.x, right);
    let mut y = frame.y.clamp(area.y, bottom);
    if (x - area.x).abs() <= threshold {
        x = area.x;
    } else if (right - x).abs() <= threshold {
        x = right;
    }
    if (y - area.y).abs() <= threshold {
        y = area.y;
    } else if (bottom - y).abs() <= threshold {
        y = bottom;
    }
    (x, y)
}
pub fn settle(app: &AppHandle, dock: bool) -> Result<(), String> {
    let snap = app
        .state::<crate::preferences::State>()
        .0
        .lock()
        .map_err(|_| "设置不可用。")?
        .values
        .snap_to_edges;
    let window = crate::main_window(app)?;
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("无法取得屏幕工作区。")?;
    let work = monitor.work_area();
    let visible = frame(&window)?;
    let gap = (12.0 * monitor.scale_factor()).round() as u32;
    let gap_x = gap.min(work.size.width.saturating_sub(visible.width) / 2);
    let gap_y = gap.min(work.size.height.saturating_sub(visible.height) / 2);
    let (x, y) = snapped(
        visible,
        Frame {
            x: work.position.x + gap_x as i32,
            y: work.position.y + gap_y as i32,
            width: work.size.width - gap_x * 2,
            height: work.size.height - gap_y * 2,
        },
        if snap {
            (16.0 * monitor.scale_factor()).round() as i32
        } else {
            0
        },
        dock && snap,
    );
    let outer = window.outer_position().map_err(|e| e.to_string())?;
    move_to(&window, outer.x + x - visible.x, outer.y + y - visible.y)
}

#[cfg(windows)]
fn alpha(window: &WebviewWindow) -> u8 {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetLayeredWindowAttributes, GetWindowLongPtrW, GWL_EXSTYLE, LWA_ALPHA, WS_EX_LAYERED,
    };
    let Ok(hwnd) = window.hwnd() else {
        return 255;
    };
    let mut key = 0;
    let mut value = 255;
    let mut flags = 0;
    unsafe {
        if GetWindowLongPtrW(hwnd.0 as _, GWL_EXSTYLE) & WS_EX_LAYERED as isize != 0
            && GetLayeredWindowAttributes(hwnd.0 as _, &mut key, &mut value, &mut flags) != 0
            && flags & LWA_ALPHA != 0
        {
            value
        } else {
            255
        }
    }
}
fn is_layered(window: &WebviewWindow) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            GetWindowLongPtrW, GWL_EXSTYLE, WS_EX_LAYERED,
        };
        return window.hwnd().map(|hwnd| unsafe { GetWindowLongPtrW(hwnd.0 as _, GWL_EXSTYLE) } & WS_EX_LAYERED as isize != 0).unwrap_or(false);
    }
    #[cfg(not(windows))]
    false
}

pub fn apply(
    window: &WebviewWindow,
    mini: bool,
    prefs: &crate::preferences::Preferences,
) -> Result<(), String> {
    let focused = window.is_focused().unwrap_or(false);
    let state = window.app_handle().state::<State>();
    let mut runtime = state.0.lock().map_err(|_| "小窗状态不可用。")?;
    let dimmed = mini && prefs.dim_inactive && !focused && !runtime.inside && !runtime.dragging;
    let percent = if !mini {
        100
    } else if dimmed {
        ((prefs.mini_opacity as f64 * 0.60).round() as u8).max(25)
    } else {
        prefs.mini_opacity
    };
    let was_layered = is_layered(window);
    let glass = mini
        && prefs.acrylic
        && crate::material::has_acrylic(window)
        && (!was_layered || runtime.owns_layered);
    // Keep the system backdrop on a non-layered glass host. Fade the WebView
    // content/tint instead; solid mode retains native window alpha.
    let native_percent = if glass { 100 } else { percent };
    let transition = runtime.mini != mini;
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{GetLastError, SetLastError},
            UI::WindowsAndMessaging::{
                GetLayeredWindowAttributes, GetWindowLongPtrW, SetLayeredWindowAttributes,
                SetWindowLongPtrW, GWL_EXSTYLE, LWA_ALPHA, WS_EX_LAYERED,
            },
        };
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        let current = unsafe { GetWindowLongPtrW(hwnd.0 as _, GWL_EXSTYLE) };
        if native_percent < 100 || runtime.owns_layered || runtime.original_attributes.is_some() {
            if current & WS_EX_LAYERED as isize == 0 {
                unsafe {
                    SetLastError(0);
                    SetWindowLongPtrW(hwnd.0 as _, GWL_EXSTYLE, current | WS_EX_LAYERED as isize);
                }
                if unsafe { GetLastError() } != 0 {
                    return Err(std::io::Error::last_os_error().to_string());
                }
                runtime.owns_layered = true;
            } else if !runtime.owns_layered && runtime.original_attributes.is_none() {
                let mut key = 0;
                let mut original = 255;
                let mut flags = 0;
                if unsafe {
                    GetLayeredWindowAttributes(hwnd.0 as _, &mut key, &mut original, &mut flags)
                } != 0
                {
                    runtime.original_attributes = Some((key, original, flags));
                }
            }
            let (key, _, flags) = runtime.original_attributes.unwrap_or((0, 255, LWA_ALPHA));
            let value = ((native_percent as u16 * 255 + 50) / 100) as u8;
            if unsafe { SetLayeredWindowAttributes(hwnd.0 as _, key, value, flags | LWA_ALPHA) }
                == 0
            {
                return Err(std::io::Error::last_os_error().to_string());
            }
            if !mini || glass {
                if runtime.owns_layered {
                    unsafe {
                        SetWindowLongPtrW(
                            hwnd.0 as _,
                            GWL_EXSTYLE,
                            GetWindowLongPtrW(hwnd.0 as _, GWL_EXSTYLE) & !(WS_EX_LAYERED as isize),
                        );
                    }
                    runtime.owns_layered = false;
                } else if let Some((key, value, flags)) = runtime.original_attributes.take() {
                    unsafe {
                        SetLayeredWindowAttributes(hwnd.0 as _, key, value, flags);
                    }
                }
            }
        }
    }
    runtime.dimmed = dimmed;
    runtime.content_opacity = if glass { percent } else { 100 };
    runtime.acrylic = glass;
    runtime.mini = mini;
    drop(runtime);
    if transition || was_layered != is_layered(window) {
        crate::material::restore_backdrop(window, prefs.acrylic)?;
    }
    Ok(())
}
pub fn refresh(app: &AppHandle) -> Result<(), String> {
    let Some(desktop) = app.try_state::<crate::Desktop>() else {
        return Ok(());
    };
    let Some(prefs) = app.try_state::<crate::preferences::State>() else {
        return Ok(());
    };
    let mini = desktop.0.lock().map_err(|_| "窗口状态不可用。")?.mini;
    let values = prefs.0.lock().map_err(|_| "设置不可用。")?.values.clone();
    if let Ok(window) = crate::main_window(app) {
        shell_mode(app, &window, mini)?;
        apply(&window, mini, &values)?;
        let dragging = app
            .state::<State>()
            .0
            .lock()
            .map_err(|_| "小窗状态不可用。")?
            .dragging;
        if mini && !dragging {
            settle(app, false)?;
        }
    }
    Ok(())
}
pub fn dragging(app: &AppHandle, active: bool) {
    let mut changed = false;
    if let Some(state) = app.try_state::<State>() {
        if let Ok(mut runtime) = state.0.lock() {
            changed = runtime.dragging != active;
            runtime.dragging = active;
        }
    }
    if changed {
        let _ = refresh(app);
    }
}
pub fn is_dragging(app: &AppHandle) -> bool {
    app.try_state::<State>().is_some_and(|state| {
        state
            .0
            .try_lock()
            .map(|runtime| runtime.dragging)
            .unwrap_or(true)
    })
}
pub fn snapshot(window: &WebviewWindow) -> Result<Snapshot, String> {
    let state = window.app_handle().state::<State>();
    let runtime = state.0.lock().map_err(|_| "小窗状态不可用。")?;
    let (dimmed, dragging, inside, acrylic) = (
        runtime.dimmed,
        runtime.dragging,
        runtime.inside,
        runtime.acrylic,
    );
    let content_opacity = if acrylic {
        runtime.content_opacity
    } else {
        100
    };
    drop(runtime);
    #[cfg(windows)]
    let opacity = ((alpha(window) as u16 * 100 + 127) / 255) as u8;
    #[cfg(not(windows))]
    let opacity = 100;
    let (tool_window, app_window) = shell_flags(window)?;
    Ok(Snapshot {
        effective_opacity: ((opacity as u16 * content_opacity as u16 + 50) / 100) as u8,
        native_opacity: opacity,
        content_opacity,
        acrylic,
        layered: is_layered(window),
        dimmed,
        dragging,
        focused: window.is_focused().unwrap_or(false),
        pointer_inside: inside,
        frame: frame(window)?,
        tool_window,
        app_window,
    })
}
#[tauri::command]
pub fn widget_activity(app: AppHandle, window: WebviewWindow, inside: bool) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只允许操作时钟主窗口。".into());
    }
    app.state::<State>()
        .0
        .lock()
        .map_err(|_| "小窗状态不可用。")?
        .inside = inside;
    refresh(&app)
}

#[tauri::command]
pub fn widget_menu(
    app: AppHandle,
    window: WebviewWindow,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<(), String> {
    if window.label() != "main"
        || !app
            .state::<crate::Desktop>()
            .0
            .lock()
            .map_err(|_| "窗口状态不可用。")?
            .mini
    {
        return Ok(());
    }
    let prefs = app
        .state::<crate::preferences::State>()
        .0
        .lock()
        .map_err(|_| "设置不可用。")?
        .values
        .clone();
    let title = MenuItem::new(
        &app,
        crate::i18n::translate(prefs.language, "小窗不透明度"),
        false,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let a = CheckMenuItem::with_id(
        &app,
        "widget.opacity.100",
        "100%",
        true,
        prefs.mini_opacity == 100,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let b = CheckMenuItem::with_id(
        &app,
        "widget.opacity.85",
        "85%",
        true,
        prefs.mini_opacity == 85,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let c = CheckMenuItem::with_id(
        &app,
        "widget.opacity.65",
        "65%",
        true,
        prefs.mini_opacity == 65,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let d = CheckMenuItem::with_id(
        &app,
        "widget.opacity.40",
        "40%",
        true,
        prefs.mini_opacity == 40,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let separator = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let dim = CheckMenuItem::with_id(
        &app,
        "widget.dim",
        crate::i18n::translate(prefs.language, "失焦时淡化"),
        true,
        prefs.dim_inactive,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let snap = CheckMenuItem::with_id(
        &app,
        "widget.snap",
        crate::i18n::translate(prefs.language, "贴边吸附"),
        true,
        prefs.snap_to_edges,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let restore = MenuItem::with_id(
        &app,
        "widget.restore",
        crate::i18n::translate(prefs.language, "恢复主窗口"),
        true,
        None::<&str>,
    )
    .map_err(|e| e.to_string())?;
    let menu = Menu::with_items(
        &app,
        &[&title, &a, &b, &c, &d, &separator, &dim, &snap, &restore],
    )
    .map_err(|e| e.to_string())?;
    if let (Some(x), Some(y)) = (x, y) {
        menu.popup_at(
            window.as_ref().window().clone(),
            tauri::LogicalPosition::new(x, y),
        )
        .map_err(|e| e.to_string())
    } else {
        menu.popup(window.as_ref().window().clone())
            .map_err(|e| e.to_string())
    }
}
pub fn menu_action(app: &AppHandle, id: &str) -> Result<(), String> {
    if let Some(value) = id
        .strip_prefix("widget.opacity.")
        .and_then(|v| v.parse::<u8>().ok())
    {
        crate::preferences::patch_widget(app, Some(value), None, None)?;
    } else if id == "widget.restore" {
        crate::apply_desktop_action(app, "mini")?;
    } else if id == "widget.dim" || id == "widget.snap" {
        let values = app
            .state::<crate::preferences::State>()
            .0
            .lock()
            .map_err(|_| "设置不可用。")?
            .values
            .clone();
        crate::preferences::patch_widget(
            app,
            None,
            if id == "widget.dim" {
                Some(!values.dim_inactive)
            } else {
                None
            },
            if id == "widget.snap" {
                Some(!values.snap_to_edges)
            } else {
                None
            },
        )?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snap_accounts_for_work_area_negative_coordinates_and_clamping() {
        let area = Frame {
            x: -1920,
            y: 0,
            width: 1920,
            height: 1040,
        };
        assert_eq!(
            snapped(
                Frame {
                    x: -282,
                    y: 934,
                    width: 280,
                    height: 104
                },
                area,
                16,
                false
            ),
            (-280, 936)
        );
        assert_eq!(
            snapped(
                Frame {
                    x: -2100,
                    y: -200,
                    width: 280,
                    height: 104
                },
                area,
                0,
                false
            ),
            (-1920, 0)
        );
        assert_eq!(
            snapped(
                Frame {
                    x: -800,
                    y: 500,
                    width: 280,
                    height: 104
                },
                area,
                16,
                false
            ),
            (-800, 500)
        );
    }
}
