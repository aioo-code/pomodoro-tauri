#![cfg(windows)]
// Windows accent-policy ABI, also used by Tauri's window-vibrancy project.
// The entry point is resolved dynamically; unsupported systems keep the DWM fallback.
use std::{
    collections::HashMap,
    ffi::c_void,
    mem::size_of,
    sync::{Mutex, OnceLock},
};
use tauri::WebviewWindow;
use windows_sys::Win32::{
    Foundation::HWND,
    System::LibraryLoader::{GetModuleHandleW, GetProcAddress},
};

#[repr(C)]
struct AccentPolicy {
    state: i32,
    flags: u32,
    color: u32,
    animation: u32,
}
#[repr(C)]
struct CompositionData {
    attribute: i32,
    data: *mut c_void,
    size: usize,
}
type SetComposition = unsafe extern "system" fn(HWND, *mut CompositionData) -> i32;
#[derive(Clone, Copy)]
pub struct Surface;
static SURFACES: OnceLock<Mutex<HashMap<usize, Surface>>> = OnceLock::new();
fn surfaces() -> &'static Mutex<HashMap<usize, Surface>> {
    SURFACES.get_or_init(Default::default)
}
fn entry() -> Option<SetComposition> {
    static ENTRY: OnceLock<Option<SetComposition>> = OnceLock::new();
    *ENTRY.get_or_init(|| unsafe {
        let name: Vec<u16> = "user32.dll\0".encode_utf16().collect();
        let module = GetModuleHandleW(name.as_ptr());
        if module.is_null() {
            return None;
        }
        GetProcAddress(module, b"SetWindowCompositionAttribute\0".as_ptr()).map(|function| {
            // Same Win32 system ABI and pointer-sized function address as the export.
            std::mem::transmute::<unsafe extern "system" fn() -> isize, SetComposition>(function)
        })
    })
}
fn send(window: &WebviewWindow, state: i32, color: u32) -> bool {
    let Some(set) = entry() else {
        return false;
    };
    let Ok(hwnd) = window.hwnd() else {
        return false;
    };
    let mut policy = AccentPolicy {
        state,
        flags: 2,
        color,
        animation: 0,
    };
    let mut data = CompositionData {
        attribute: 19,
        data: (&mut policy as *mut AccentPolicy).cast(),
        size: size_of::<AccentPolicy>(),
    };
    // Both stack structures live for this synchronous call on our own HWND.
    unsafe { set(hwnd.0 as _, &mut data) != 0 }
}
fn tint(dark: bool) -> u32 {
    let (r, g, b, alpha) = if dark {
        (12, 16, 23, 51)
    } else {
        (248, 250, 252, 102)
    };
    (alpha << 24) | (b << 16) | (g << 8) | r
}
pub fn surface(window: &WebviewWindow) -> Option<Surface> {
    let key = window.hwnd().ok()?.0 as usize;
    surfaces().lock().ok()?.get(&key).copied()
}
pub fn system_allows() -> bool {
    use windows_sys::Win32::{
        System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD},
        UI::WindowsAndMessaging::SystemParametersInfoW,
    };
    let path: Vec<u16> = "Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\0"
        .encode_utf16()
        .collect();
    let name: Vec<u16> = "EnableTransparency\0".encode_utf16().collect();
    let mut enabled = 1u32;
    let mut size = 4u32;
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            path.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut enabled as *mut u32).cast(),
            &mut size,
        )
    };
    if result == 0 && enabled == 0 {
        return false;
    }
    #[repr(C)]
    struct HighContrast {
        size: u32,
        flags: u32,
        scheme: *mut u16,
    }
    let mut contrast = HighContrast {
        size: size_of::<HighContrast>() as u32,
        flags: 0,
        scheme: std::ptr::null_mut(),
    };
    let known = unsafe {
        SystemParametersInfoW(
            0x0042,
            contrast.size,
            (&mut contrast as *mut HighContrast).cast(),
            0,
        )
    } != 0;
    !(known && contrast.flags & 1 != 0)
}
pub fn configure(window: &WebviewWindow, enabled: bool, dark: bool) -> bool {
    let Ok(hwnd) = window.hwnd() else {
        return false;
    };
    let key = hwnd.0 as usize;
    if !enabled {
        if surface(window).is_some() {
            let _ = send(window, 0, 0);
            if let Ok(mut map) = surfaces().lock() {
                map.remove(&key);
            }
        }
        return false;
    }
    if send(window, 4, tint(dark)) {
        if let Ok(mut map) = surfaces().lock() {
            map.insert(key, Surface);
        }
        true
    } else {
        false
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accent_abi_and_color_encoding() {
        assert_eq!(size_of::<AccentPolicy>(), 16);
        assert_eq!(size_of::<CompositionData>(), 24);
        assert_eq!(tint(true), 0x3317100c);
        assert_eq!(tint(false), 0x66fcfaf8);
    }
}
