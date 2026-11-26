use tauri::{AppHandle, Manager, WebviewWindow};

pub fn apply_muted(app: &AppHandle, muted: bool) {
    let qa = app
        .state::<crate::Desktop>()
        .0
        .lock()
        .map(|data| data.qa)
        .unwrap_or(true);
    for label in ["main", "reminder"] {
        if let Some(window) = app.get_webview_window(label) {
            let hidden_reminder = label == "reminder" && !window.is_visible().unwrap_or(false);
            mute(&window, qa || muted || hidden_reminder);
        }
    }
}

// Native muting still works when a hidden WebView has suspended JavaScript.
pub fn mute(window: &WebviewWindow, muted: bool) {
    #[cfg(windows)]
    let _ = window.with_webview(move |view| {
        use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
        use windows_core::Interface;
        let result = unsafe {
            view.controller()
                .CoreWebView2()
                .and_then(|core| core.cast::<ICoreWebView2_8>())
                .and_then(|core| core.SetIsMuted(muted))
        };
        if let Err(error) = result {
            eprintln!("Audio mute: {error}");
        }
    });
}

#[tauri::command]
pub async fn audio_window_state(
    window: WebviewWindow,
    label: Option<String>,
) -> Result<bool, String> {
    if !window
        .state::<crate::Desktop>()
        .0
        .lock()
        .map_err(|_| "Desktop unavailable")?
        .qa
    {
        return Err("Only available in an isolated QA profile".into());
    }
    let window = window
        .app_handle()
        .get_webview_window(label.as_deref().unwrap_or(window.label()))
        .ok_or("Window unavailable")?;
    #[cfg(windows)]
    return tauri::async_runtime::spawn_blocking(move || {
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        window
            .with_webview(move |view| {
                use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_8;
                use windows_core::Interface;
                let result = unsafe {
                    view.controller()
                        .CoreWebView2()
                        .and_then(|core| core.cast::<ICoreWebView2_8>())
                        .and_then(|core| {
                            let mut value = windows_core::BOOL(0);
                            core.IsMuted(&mut value)?;
                            Ok(value.as_bool())
                        })
                };
                let _ = send.send(result.map_err(|error| error.to_string()));
            })
            .map_err(|error| error.to_string())?;
        receive
            .recv_timeout(std::time::Duration::from_secs(3))
            .map_err(|error| error.to_string())?
    })
    .await
    .map_err(|error| error.to_string())?;
    #[cfg(not(windows))]
    Ok(true)
}
