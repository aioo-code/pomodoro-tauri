use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, Theme, WebviewWindow};

pub struct State(pub Mutex<String>, pub Mutex<Option<Theme>>);
impl Default for State {
    fn default() -> Self {
        Self(Mutex::new("system".into()), Mutex::new(None))
    }
}

fn resolve_theme(app: &AppHandle, choice: &str) -> Result<Theme, String> {
    match choice {
        "light" => Ok(Theme::Light),
        "dark" => Ok(Theme::Dark),
        "system" => read_system_theme(app),
        _ => Err("请选择浅色、深色或跟随系统。".into()),
    }
}

fn read_system_theme(app: &AppHandle) -> Result<Theme, String> {
    if app.config().identifier.ends_with(".toolqa") {
        if let Some(theme) = app
            .state::<State>()
            .1
            .lock()
            .map_err(|_| "测试主题不可用。")?
            .clone()
        {
            return Ok(theme);
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Registry::{
            RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD,
        };
        let key: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0"
            .encode_utf16()
            .collect();
        let name: Vec<u16> = "AppsUseLightTheme\0".encode_utf16().collect();
        let mut value = 1u32;
        let mut bytes = size_of::<u32>() as u32;
        // SAFETY: read-only HKCU query restricted to a DWORD, with a correctly sized buffer.
        let result = unsafe {
            RegGetValueW(
                HKEY_CURRENT_USER,
                key.as_ptr(),
                name.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut value as *mut u32).cast(),
                &mut bytes,
            )
        };
        if ![0, 2, 3].contains(&result) {
            return Err(format!("无法读取 Windows 应用明暗模式（{result}）。"));
        }
        let _ = app;
        Ok(if value == 0 {
            Theme::Dark
        } else {
            Theme::Light
        })
    }
    #[cfg(not(windows))]
    {
        app.get_webview_window("main")
            .ok_or("时钟窗口尚未就绪。")?
            .theme()
            .map_err(|error| error.to_string())
    }
}

pub fn set_qa_system_theme(app: &AppHandle, theme: &str) -> Result<String, String> {
    if !app.config().identifier.ends_with(".toolqa") {
        return Err("Only available in the isolated QA instance".into());
    }
    let value = match theme {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        "system" => None,
        _ => return Err("Invalid QA theme".into()),
    };
    *app.state::<State>()
        .1
        .lock()
        .map_err(|_| "测试主题不可用。")? = value;
    system_theme(app.clone())
}

pub fn watch_system(app: AppHandle) {
    std::thread::spawn(move || {
        let mut previous = system_theme(app.clone()).ok();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(1));
            if let Ok(next) = system_theme(app.clone()) {
                if previous.as_ref() != Some(&next) {
                    let _ = app.emit("system-theme-changed", &next);
                    previous = Some(next);
                }
            }
        }
    });
}

#[tauri::command]
pub fn system_theme(app: AppHandle) -> Result<String, String> {
    Ok(if resolve_theme(&app, "system")? == Theme::Dark {
        "dark"
    } else {
        "light"
    }
    .into())
}

#[cfg(windows)]
fn optional_dwm(result: i32) -> Result<bool, String> {
    match result as u32 {
        // Older Windows versions reject newer DWM attributes. Composition can also
        // be unavailable in a remote session. These are optional visual features.
        0x80070057 | 0x80004001 | 0x80070032 | 0x80263001 => Ok(false),
        _ if result >= 0 => Ok(true),
        _ => Err(format!("窗口外观设置失败（{result:#x}）。")),
    }
}

#[cfg(all(test, windows))]
mod tests {
    #[test]
    fn unsupported_visuals_fall_back_but_invalid_handles_still_fail() {
        assert_eq!(super::optional_dwm(0), Ok(true));
        for code in [0x80070057u32, 0x80004001, 0x80070032, 0x80263001] {
            assert_eq!(super::optional_dwm(code as i32), Ok(false));
        }
        for code in [0x80070005u32, 0x80070578, 0x80004005] {
            assert!(super::optional_dwm(code as i32).is_err());
        }
    }
}

#[cfg(windows)]
fn legacy_material(window: &WebviewWindow) -> bool {
    // Only isolated QA instances can inject an unsupported-attribute response.
    window.app_handle().config().identifier.ends_with(".toolqa")
        && std::env::args().any(|arg| arg == "--qa-legacy-material")
}

#[cfg(windows)]
fn set_attribute(window: &WebviewWindow, attribute: i32, value: i32) -> Result<bool, String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let result = if legacy_material(window) {
        0x80070057u32 as i32
    } else {
        // SAFETY: live owned HWND; these DWM attributes accept a four-byte value.
        unsafe {
            windows_sys::Win32::Graphics::Dwm::DwmSetWindowAttribute(
                hwnd.0 as _,
                attribute as u32,
                (&value as *const i32).cast(),
                size_of::<i32>() as u32,
            )
        }
    };
    optional_dwm(result)
}

pub fn set_corners(app: &AppHandle, radius: u8) -> Result<(), String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Graphics::Dwm::DWMWA_WINDOW_CORNER_PREFERENCE;
        // DWM supports square, small and regular native corners; controls use the exact slider value.
        let value: i32 = if radius == 0 {
            1
        } else if radius < 12 {
            3
        } else {
            2
        };
        for label in ["main", "reminder"] {
            let window = app.get_webview_window(label).ok_or("窗口尚未就绪。")?;
            set_attribute(&window, DWMWA_WINDOW_CORNER_PREFERENCE, value)?;
        }
    }
    #[cfg(not(windows))]
    let _ = (app, radius);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowMaterial {
    backdrop_type: i32,
    acrylic: bool,
    backend: String,
    dark_mode: bool,
    corner_preference: i32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    theme: String,
    choice: String,
    acrylic: bool,
    main: WindowMaterial,
    reminder: WindowMaterial,
}

#[cfg(windows)]
fn read(window: &WebviewWindow) -> Result<WindowMaterial, String> {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmGetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE, DWMWA_USE_IMMERSIVE_DARK_MODE,
        DWMWA_WINDOW_CORNER_PREFERENCE,
    };
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let get = |attribute: i32, fallback: i32| -> Result<i32, String> {
        let mut value = 0i32;
        // SAFETY: live owned HWND, correctly sized output, and documented DWM attributes.
        let result = if legacy_material(window) {
            0x80070057u32 as i32
        } else {
            unsafe {
                DwmGetWindowAttribute(
                    hwnd.0 as _,
                    attribute as u32,
                    (&mut value as *mut i32).cast(),
                    size_of::<i32>() as u32,
                )
            }
        };
        Ok(if optional_dwm(result)? {
            value
        } else {
            fallback
        })
    };
    let backdrop_type = get(DWMWA_SYSTEMBACKDROP_TYPE, 1)?;
    let custom = crate::acrylic::surface(window);
    Ok(WindowMaterial {
        backdrop_type,
        acrylic: custom.is_some() || backdrop_type == 3,
        backend: if custom.is_some() {
            "accent-acrylic"
        } else if backdrop_type == 3 {
            "system-acrylic"
        } else {
            "solid"
        }
        .into(),
        dark_mode: get(
            DWMWA_USE_IMMERSIVE_DARK_MODE,
            i32::from(window.theme().ok() == Some(Theme::Dark)),
        )? != 0,
        corner_preference: get(DWMWA_WINDOW_CORNER_PREFERENCE, 1)?,
    })
}

#[cfg(windows)]
fn apply(window: &WebviewWindow, dark: bool, system: bool, acrylic: bool) -> Result<(), String> {
    use windows_sys::Win32::Graphics::Dwm::DWMWA_USE_IMMERSIVE_DARK_MODE;
    window
        .set_theme(if system {
            None
        } else {
            Some(if dark { Theme::Dark } else { Theme::Light })
        })
        .map_err(|e| e.to_string())?;
    set_attribute(window, DWMWA_USE_IMMERSIVE_DARK_MODE, i32::from(dark))?;
    restore_backdrop(window, acrylic)?;
    Ok(())
}

pub fn has_acrylic(window: &WebviewWindow) -> bool {
    #[cfg(windows)]
    return read(window)
        .map(|material| material.acrylic)
        .unwrap_or(false);
    #[cfg(not(windows))]
    false
}

// Frame/style changes can invalidate the extended glass client area. Reapply
// just the backdrop without changing the selected theme or taking preference locks.
#[cfg(windows)]
pub fn restore_backdrop(window: &WebviewWindow, acrylic: bool) -> Result<(), String> {
    use windows_sys::Win32::Graphics::Dwm::{
        DwmExtendFrameIntoClientArea, DWMSBT_TRANSIENTWINDOW, DWMWA_SYSTEMBACKDROP_TYPE,
    };
    use windows_sys::Win32::UI::Controls::MARGINS;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?;
    let supported = set_attribute(
        window,
        DWMWA_SYSTEMBACKDROP_TYPE,
        if acrylic { DWMSBT_TRANSIENTWINDOW } else { 1 },
    )?;
    let acrylic = acrylic && supported;
    let dark = read(window)
        .map(|material| material.dark_mode)
        .unwrap_or(false);
    if acrylic && !legacy_material(window) && crate::acrylic::system_allows() {
        set_attribute(window, DWMWA_SYSTEMBACKDROP_TYPE, 1)?;
        if !crate::acrylic::configure(window, true, dark) {
            set_attribute(window, DWMWA_SYSTEMBACKDROP_TYPE, DWMSBT_TRANSIENTWINDOW)?;
        }
    } else {
        crate::acrylic::configure(window, false, dark);
    }
    let margins = MARGINS {
        cxLeftWidth: if acrylic { -1 } else { 0 },
        cxRightWidth: if acrylic { -1 } else { 0 },
        cyTopHeight: if acrylic { -1 } else { 0 },
        cyBottomHeight: if acrylic { -1 } else { 0 },
    };
    // Extend DWM's material through the transparent WebView client area.
    let result = unsafe { DwmExtendFrameIntoClientArea(hwnd.0 as _, &margins) };
    optional_dwm(result)?;
    Ok(())
}

#[cfg(not(windows))]
pub fn restore_backdrop(_window: &WebviewWindow, _acrylic: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn set_appearance(app: AppHandle, theme: String) -> Result<Appearance, String> {
    let values = app
        .state::<crate::preferences::State>()
        .0
        .lock()
        .map_err(|_| "设置暂时不可用。")?
        .values
        .clone();
    let state = app.state::<State>();
    let mut choice = state.0.lock().map_err(|_| "外观状态暂时不可用。")?;
    let result = apply_appearance(&app, &theme, values.acrylic, values.corner_radius)?;
    *choice = theme;
    Ok(result)
}

pub fn apply_preferences(app: &AppHandle, acrylic: bool, radius: u8) -> Result<Appearance, String> {
    let state = app.state::<State>();
    let choice = state.0.lock().map_err(|_| "外观状态暂时不可用。")?;
    apply_appearance(app, &choice, acrylic, radius)
}

fn apply_appearance(
    app: &AppHandle,
    choice: &str,
    acrylic: bool,
    radius: u8,
) -> Result<Appearance, String> {
    let dark = resolve_theme(app, choice)? == Theme::Dark;
    let main = app.get_webview_window("main").ok_or("时钟窗口不可用。")?;
    let reminder = app
        .get_webview_window("reminder")
        .ok_or("提醒窗口不可用。")?;
    #[cfg(windows)]
    {
        apply(&main, dark, choice == "system", acrylic)?;
        apply(&reminder, dark, choice == "system", acrylic)?;
        set_corners(app, radius)?;
        let main = read(&main)?;
        let reminder = read(&reminder)?;
        Ok(Appearance {
            acrylic: main.acrylic && reminder.acrylic,
            theme: if dark { "dark" } else { "light" }.into(),
            choice: choice.into(),
            main,
            reminder,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (main, reminder, dark, acrylic, radius);
        Err("原生磨砂材质需要 Windows 11。".into())
    }
}

#[tauri::command]
pub fn appearance_state(app: AppHandle) -> Result<Appearance, String> {
    #[cfg(windows)]
    {
        let main = read(&app.get_webview_window("main").ok_or("时钟窗口不可用。")?)?;
        let reminder = read(
            &app.get_webview_window("reminder")
                .ok_or("提醒窗口不可用。")?,
        )?;
        Ok(Appearance {
            theme: if main.dark_mode { "dark" } else { "light" }.into(),
            choice: app
                .state::<State>()
                .0
                .lock()
                .map_err(|_| "外观状态暂时不可用。")?
                .clone(),
            acrylic: main.acrylic && reminder.acrylic,
            main,
            reminder,
        })
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("原生磨砂材质需要 Windows 11。".into())
    }
}
