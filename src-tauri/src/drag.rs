use serde::Serialize;
use std::{collections::VecDeque, sync::Mutex};
use tauri::{AppHandle, Manager, WebviewWindow};
#[derive(Default)]
pub struct State(Mutex<Stream>);
#[derive(Default)]
struct Stream {
    active: Option<Gesture>,
    completed: VecDeque<String>,
}
struct Gesture {
    id: String,
    sequence: u64,
    origin: (i32, i32),
    start: (f64, f64),
    scale: f64,
}
#[derive(Serialize)]
pub struct Geometry {
    x: i32,
    y: i32,
    scale: f64,
}
#[tauri::command]
pub fn native_drag(window: WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只能拖动时钟主窗口。".into());
    }
    window.start_dragging().map_err(|e| e.to_string())
}

#[cfg(windows)]
pub fn install(window: &WebviewWindow) -> Result<(), String> {
    use windows_sys::Win32::UI::{
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{WM_ENTERSIZEMOVE, WM_EXITSIZEMOVE, WM_NCDESTROY},
    };
    unsafe extern "system" fn callback(
        hwnd: windows_sys::Win32::Foundation::HWND,
        message: u32,
        wparam: usize,
        lparam: isize,
        id: usize,
        data: usize,
    ) -> isize {
        // This boxed handle belongs exclusively to this HWND subclass; Windows
        // invokes it on the owning UI thread until WM_NCDESTROY releases it.
        let result = unsafe { DefSubclassProc(hwnd, message, wparam, lparam) };
        if message == WM_NCDESTROY {
            unsafe {
                RemoveWindowSubclass(hwnd, Some(callback), id);
                drop(Box::from_raw(data as *mut AppHandle));
            }
        } else if message == WM_ENTERSIZEMOVE || message == WM_EXITSIZEMOVE {
            let app = unsafe { &*(data as *const AppHandle) };
            crate::widget::dragging(app, message == WM_ENTERSIZEMOVE);
            if message == WM_EXITSIZEMOVE {
                if let Ok(window) = crate::main_window(app) {
                    crate::layout::changed(&window, false);
                }
                let _ = crate::widget::settle(app, false);
            }
        }
        result
    }
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let data = Box::into_raw(Box::new(window.app_handle().clone()));
    if unsafe { SetWindowSubclass(hwnd.0 as _, Some(callback), 0x504F4D44, data as usize) } == 0 {
        unsafe {
            drop(Box::from_raw(data));
        }
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}
#[cfg(not(windows))]
pub fn install(_: &WebviewWindow) -> Result<(), String> {
    Ok(())
}
#[tauri::command]
pub fn drag_geometry(window: WebviewWindow) -> Result<Geometry, String> {
    if window.label() != "main" {
        return Err("只能拖动时钟主窗口。".into());
    }
    let p = window.outer_position().map_err(|e| e.to_string())?;
    Ok(Geometry {
        x: p.x,
        y: p.y,
        scale: window.scale_factor().map_err(|e| e.to_string())?,
    })
}
#[tauri::command]
pub fn drag_to(window: WebviewWindow, x: i32, y: i32) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只能拖动时钟主窗口。".into());
    }
    crate::widget::move_to(&window, x, y)
}
#[tauri::command]
pub fn drag_update(
    app: AppHandle,
    window: WebviewWindow,
    gesture: String,
    sequence: u64,
    start_x: f64,
    start_y: f64,
    x: f64,
    y: f64,
    finish: bool,
    cancelled: bool,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("只能拖动时钟主窗口。".into());
    }
    if gesture.len() > 64
        || gesture.is_empty()
        || ![start_x, start_y, x, y].iter().all(|v| v.is_finite())
    {
        return Err("拖动参数无效。".into());
    }
    let state = app.state::<State>();
    let mut stream = state.0.lock().map_err(|_| "拖动状态不可用。")?;
    if stream.completed.contains(&gesture) {
        return Ok(());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    if stream
        .active
        .as_ref()
        .is_none_or(|active| active.id != gesture)
    {
        if let Some(old) = stream.active.take() {
            stream.completed.push_back(old.id);
        }
        let p = window.outer_position().map_err(|e| e.to_string())?;
        stream.active = Some(Gesture {
            id: gesture.clone(),
            sequence: 0,
            origin: (p.x, p.y),
            start: (start_x, start_y),
            scale,
        });
    }
    let active = stream.active.as_mut().unwrap();
    if sequence <= active.sequence {
        return Ok(());
    }
    active.sequence = sequence;
    if (scale - active.scale).abs() > 0.01 {
        let p = window.outer_position().map_err(|e| e.to_string())?;
        active.origin = (p.x, p.y);
        active.start = (x, y);
        active.scale = scale;
    }
    let position = (
        (active.origin.0 as f64 + (x - active.start.0) * active.scale).round() as i32,
        (active.origin.1 as f64 + (y - active.start.1) * active.scale).round() as i32,
    );
    crate::widget::dragging(&app, true);
    crate::widget::move_to(&window, position.0, position.1)?;
    if finish {
        stream.active = None;
        stream.completed.push_back(gesture);
    }
    while stream.completed.len() > 32 {
        stream.completed.pop_front();
    }
    if finish {
        if !cancelled {
            crate::widget::settle(&app, false)?;
        }
        crate::widget::dragging(&app, false);
        crate::layout::changed(&window, false);
    }
    drop(stream);
    Ok(())
}
