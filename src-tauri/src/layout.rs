//! Window geometry is stored in DIPs; monitor work areas and HWND positions are pixels.
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, LogicalSize, Manager, PhysicalPosition, WebviewWindow};

#[derive(Clone, Copy, PartialEq)]
struct Screen {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}

#[derive(Default)]
pub struct State(Mutex<HashMap<String, Screen>>);

pub fn fit(size: LogicalSize<f64>, area: (u32, u32), scale: f64) -> LogicalSize<f64> {
    // Keep the same 12-DIP breathing room as edge snapping. On tiny work areas,
    // reduce the gap instead of allowing minimum constraints to push controls offscreen.
    let available = |pixels: u32| {
        let logical = (pixels as f64 / scale).floor().max(1.0);
        (logical - 24.0_f64.min(logical / 10.0)).floor().max(1.0)
    };
    LogicalSize::new(
        size.width.min(available(area.0)),
        size.height.min(available(area.1)),
    )
}

pub fn resize(window: &WebviewWindow, wanted: LogicalSize<f64>, mini: bool) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()?.or(window.primary_monitor()?) else {
        return Ok(());
    };
    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let size = fit(wanted, (area.size.width, area.size.height), scale);
    let min = fit(
        if mini {
            LogicalSize::new(260.0, 80.0)
        } else {
            LogicalSize::new(360.0, 540.0)
        },
        (area.size.width, area.size.height),
        scale,
    );
    window.set_min_size(Some(min))?;
    // Explicit pixels use the destination monitor's scale, including before the
    // asynchronous WM_DPICHANGED message has updated the window's scale cache.
    window.set_size(size.to_physical::<u32>(scale))?;
    remember(window)?;
    Ok(())
}

fn screen(window: &WebviewWindow) -> tauri::Result<Option<Screen>> {
    Ok(window.current_monitor()?.map(|monitor| {
        let area = monitor.work_area();
        Screen {
            x: area.position.x,
            y: area.position.y,
            width: area.size.width,
            height: area.size.height,
            scale: monitor.scale_factor(),
        }
    }))
}

fn remember(window: &WebviewWindow) -> tauri::Result<()> {
    if let Some(screen) = screen(window)? {
        if let Ok(mut screens) = window.state::<State>().0.lock() {
            screens.insert(window.label().into(), screen);
        }
    }
    Ok(())
}

pub fn center_reminder(app: &AppHandle) -> tauri::Result<()> {
    let (Some(main), Some(reminder)) = (
        app.get_webview_window("main"),
        app.get_webview_window("reminder"),
    ) else {
        return Ok(());
    };
    let Some(monitor) = main.current_monitor()?.or(main.primary_monitor()?) else {
        return reminder.center();
    };
    let area = monitor.work_area();
    let size = fit(
        LogicalSize::new(360.0, 420.0),
        (area.size.width, area.size.height),
        monitor.scale_factor(),
    )
    .to_physical::<u32>(monitor.scale_factor());
    // Move first so the OS associates the reminder with the target screen. Its
    // DPI event schedules another centering pass after the OS finishes resizing.
    reminder.set_position(PhysicalPosition::new(
        area.position.x + (area.size.width as i64 - size.width as i64) as i32 / 2,
        area.position.y + (area.size.height as i64 - size.height as i64) as i32 / 2,
    ))?;
    reminder.set_size(size)?;
    // Frameless Windows windows still have a physical non-client inset. Center
    // the actual outer rectangle, not the requested client dimensions.
    let outer = reminder.outer_size()?;
    reminder.set_position(PhysicalPosition::new(
        area.position.x + (area.size.width as i64 - outer.width as i64) as i32 / 2,
        area.position.y + (area.size.height as i64 - outer.height as i64) as i32 / 2,
    ))?;
    remember(&reminder)
}

pub fn changed(window: &WebviewWindow, force: bool) {
    // A drag can produce hundreds of move messages per second. Reconcile the
    // monitor once at release, with only actual DPI transitions handled mid-drag.
    if !force && window.label() == "main" && crate::widget::is_dragging(window.app_handle()) {
        return;
    }
    let Ok(Some(current)) = screen(window) else {
        return;
    };
    let state = window.state::<State>();
    let Ok(mut screens) = state.0.lock() else {
        return;
    };
    let previous = screens.insert(window.label().into(), current);
    if !force && previous == Some(current) {
        return;
    }
    drop(screens);
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    let handle = app.clone();
    // Do not compete with Tao's WM_DPICHANGED suggested rectangle inside its
    // callback. Reconcile once the OS has applied its new scale and client size.
    // Tauri executes run_on_main_thread inline when called on that thread.
    // Send from a worker so this really runs after the native DPI callback.
    std::thread::spawn(move || {
        let _ = app.run_on_main_thread(move || {
            if label == "reminder" {
                let _ = center_reminder(&handle);
            } else if let Some(window) = handle.get_webview_window("main") {
                let state = handle.state::<crate::Desktop>();
                let Ok(desktop) = state.0.try_lock() else {
                    return;
                };
                let mini = desktop.mini;
                drop(desktop);
                if let Ok(size) = window.inner_size() {
                    let scale = window.scale_factor().unwrap_or(current.scale);
                    let wanted = if mini {
                        LogicalSize::new(280.0, 80.0)
                    } else {
                        size.to_logical(scale)
                    };
                    let _ = resize(&window, wanted, mini);
                    // A pointer drag owns its position until release; its DPI
                    // rebase and final settle already handle the new monitor.
                    if crate::widget::snapshot(&window).is_ok_and(|s| !s.dragging) {
                        let _ = crate::widget::settle(&handle, false);
                    }
                }
            }
        });
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fits_work_area_across_windows_scales() {
        for scale in [1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0] {
            for area in [(1920, 1040), (1366, 728), (800, 560), (320, 200)] {
                for desired in [
                    LogicalSize::new(400.0, 580.0),
                    LogicalSize::new(280.0, 80.0),
                    LogicalSize::new(360.0, 420.0),
                ] {
                    let fitted = fit(desired, area, scale);
                    let pixels = fitted.to_physical::<u32>(scale);
                    assert!(pixels.width <= area.0 && pixels.height <= area.1);
                    assert!(fitted.width <= desired.width && fitted.height <= desired.height);
                }
            }
        }
    }
    #[test]
    fn unchanged_when_work_area_has_room() {
        let size = LogicalSize::new(400.0, 580.0);
        assert_eq!(fit(size, (1920, 1040), 1.5), size);
        // Saving DIPs retains the UI dimensions when restoring on another DPI.
        for scale in [1.0, 1.25, 1.5, 2.0, 3.0] {
            assert_eq!(
                size.to_physical::<u32>(scale).to_logical::<f64>(scale),
                size
            );
        }
    }
}
