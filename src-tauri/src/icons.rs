use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{image::Image, AppHandle, Manager, WebviewWindow};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Choice {
    #[default]
    #[serde(alias = "tomato")]
    Flow,
    Orbit,
    Bloom,
    Prism,
    Graphite,
}

#[derive(Default)]
pub struct State(pub Mutex<Runtime>);
#[derive(Default)]
pub struct Runtime {
    choice: Option<Choice>,
    #[cfg(windows)]
    big: [Option<OwnedIcon>; 2],
}

#[cfg(windows)]
struct OwnedIcon(usize);
#[cfg(windows)]
impl Drop for OwnedIcon {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::DestroyIcon(self.0 as _);
        }
    }
}

#[cfg(windows)]
fn taskbar_icon(choice: Choice) -> Result<OwnedIcon, String> {
    let source = pixels(choice, false);
    let mut bgra = source.to_vec();
    let mut mask = vec![255u8; 128 * 16];
    for (index, pixel) in bgra.chunks_exact_mut(4).enumerate() {
        pixel.swap(0, 2);
        if pixel[3] > 0 {
            mask[index / 128 * 16 + (index % 128) / 8] &= !(0x80u8 >> (index % 8));
        }
    }
    // SAFETY: valid 128x128 BGRA pixels and DWORD-aligned one-bit mask; returned HICON is owned.
    let handle = unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::CreateIcon(
            std::ptr::null_mut(),
            128,
            128,
            1,
            32,
            mask.as_ptr(),
            bgra.as_ptr(),
        )
    };
    if handle.is_null() {
        Err(format!(
            "任务栏图标创建失败：{}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(OwnedIcon(handle as usize))
    }
}

fn pixels(choice: Choice, tray: bool) -> &'static [u8] {
    macro_rules! asset {
        ($id:literal) => {
            if tray {
                include_bytes!(concat!("../icons/choices/", $id, "-32.rgba"))
            } else {
                include_bytes!(concat!("../icons/choices/", $id, "-128.rgba"))
            }
        };
    }
    match choice {
        Choice::Flow => asset!("flow"),
        Choice::Orbit => asset!("orbit"),
        Choice::Bloom => asset!("bloom"),
        Choice::Prism => asset!("prism"),
        Choice::Graphite => asset!("graphite"),
    }
}

pub fn image(choice: Choice, tray: bool) -> Image<'static> {
    let size = if tray { 32 } else { 128 };
    Image::new(pixels(choice, tray), size, size)
}

pub fn apply(app: &AppHandle, choice: Choice) -> Result<(), String> {
    for (index, label) in ["main", "reminder"].into_iter().enumerate() {
        let window = app.get_webview_window(label).ok_or("窗口图标尚未就绪。")?;
        window
            .set_icon(image(choice, false))
            .map_err(|error| error.to_string())?;
        #[cfg(windows)]
        {
            use windows_sys::Win32::UI::WindowsAndMessaging::{
                SendMessageW, ICON_BIG, WM_GETICON, WM_SETICON,
            };
            let icon = taskbar_icon(choice)?;
            let hwnd = window.hwnd().map_err(|error| error.to_string())?;
            // SAFETY: only our HWND; keep the replacement icon alive until the next replacement.
            unsafe {
                SendMessageW(hwnd.0 as _, WM_SETICON, ICON_BIG as _, icon.0 as _);
            }
            if unsafe { SendMessageW(hwnd.0 as _, WM_GETICON, ICON_BIG as _, 0) } as usize != icon.0
            {
                return Err("任务栏图标未能更新。".into());
            }
            app.state::<State>()
                .0
                .lock()
                .map_err(|_| "图标状态不可用。")?
                .big[index] = Some(icon);
        }
        #[cfg(not(windows))]
        let _ = index;
    }
    app.tray_by_id("timer")
        .ok_or("托盘尚未就绪。")?
        .set_icon(Some(image(choice, true)))
        .map_err(|error| error.to_string())?;
    app.state::<State>()
        .0
        .lock()
        .map_err(|_| "图标状态不可用。")?
        .choice = Some(choice);
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowIcons {
    big: String,
    small: String,
}
fn native_icons(window: &WebviewWindow) -> Result<WindowIcons, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            SendMessageW, ICON_BIG, ICON_SMALL, WM_GETICON,
        };
        let hwnd = window.hwnd().map_err(|error| error.to_string())?;
        // SAFETY: query icon handles only from our own live window; no input or foreign window access.
        let (big, small) = unsafe {
            (
                SendMessageW(hwnd.0 as _, WM_GETICON, ICON_BIG as _, 0),
                SendMessageW(hwnd.0 as _, WM_GETICON, ICON_SMALL as _, 0),
            )
        };
        Ok(WindowIcons {
            big: format!("{big:x}"),
            small: format!("{small:x}"),
        })
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Err("Native icon inspection requires Windows".into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    choice: Choice,
    main: WindowIcons,
    reminder: WindowIcons,
    tray_update_accepted: bool,
    source_fingerprint: String,
    catalog: Vec<Choice>,
}

#[tauri::command]
pub fn icon_state(app: AppHandle) -> Result<Snapshot, String> {
    if !app.config().identifier.ends_with(".toolqa") {
        return Err("Icon inspection is available only in isolated QA".into());
    }
    let choice = app
        .state::<State>()
        .0
        .lock()
        .map_err(|_| "图标状态不可用。")?
        .choice
        .ok_or("图标尚未应用。")?;
    let mut hash = 0xcbf29ce484222325u64;
    for byte in pixels(choice, false) {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
    }
    Ok(Snapshot {
        choice,
        main: native_icons(&app.get_webview_window("main").ok_or("主窗不存在。")?)?,
        reminder: native_icons(
            &app.get_webview_window("reminder")
                .ok_or("提醒窗口不存在。")?,
        )?,
        tray_update_accepted: true,
        source_fingerprint: format!("{hash:016x}"),
        catalog: vec![
            Choice::Flow,
            Choice::Orbit,
            Choice::Bloom,
            Choice::Prism,
            Choice::Graphite,
        ],
    })
}
