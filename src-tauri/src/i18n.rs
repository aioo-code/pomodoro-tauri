use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};
use tauri::{
    menu::{Menu, MenuItem},
    AppHandle, Manager,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    Zh,
    En,
    Ja,
    De,
    Eo,
}
pub fn translate(language: Language, source: &str) -> String {
    let index = match language {
        Language::Zh => return source.into(),
        Language::En => 0,
        Language::Ja => 1,
        Language::De => 2,
        Language::Eo => 3,
    };
    static CATALOG: OnceLock<serde_json::Value> = OnceLock::new();
    CATALOG
        .get_or_init(|| {
            serde_json::from_str(include_str!("../../frontend/locales/messages.json"))
                .expect("valid translation catalog")
        })
        .get(source)
        .and_then(|v| v.get(index))
        .and_then(|v| v.as_str())
        .unwrap_or(source)
        .into()
}
#[derive(Default)]
pub struct State(pub Mutex<Vec<MenuItem<tauri::Wry>>>);
pub fn refresh(app: &AppHandle) -> Result<(), String> {
    let language = app
        .state::<crate::preferences::State>()
        .0
        .lock()
        .map_err(|_| "Language unavailable")?
        .values
        .language;
    let items: Result<Vec<_>, _> = [
        ("show", "显示番茄时钟"),
        ("toggle", "开始 / 暂停"),
        ("reset", "重置本段"),
        ("pin", "置顶 / 取消置顶"),
        ("mini", "切换小悬浮窗"),
        ("quit", "退出"),
    ]
    .into_iter()
    .map(|(id, label)| MenuItem::with_id(app, id, translate(language, label), true, None::<&str>))
    .collect();
    let items = items.map_err(|e| e.to_string())?;
    let refs: Vec<&dyn tauri::menu::IsMenuItem<_>> = items
        .iter()
        .map(|i| i as &dyn tauri::menu::IsMenuItem<_>)
        .collect();
    let menu = Menu::with_items(app, &refs).map_err(|e| e.to_string())?;
    if let Some(tray) = app.tray_by_id("timer") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        tray.set_tooltip(Some(translate(language, "番茄时钟")))
            .map_err(|e| e.to_string())?;
    }
    *app.state::<State>()
        .0
        .lock()
        .map_err(|_| "Language unavailable")? = items;
    for (label, title) in [("main", "番茄时钟"), ("reminder", "到时提醒")] {
        if let Some(window) = app.get_webview_window(label) {
            window
                .set_title(&translate(language, title))
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
#[tauri::command]
pub fn language_state(app: AppHandle) -> Result<serde_json::Value, String> {
    let language = app
        .state::<crate::preferences::State>()
        .0
        .lock()
        .map_err(|_| "Language unavailable")?
        .values
        .language;
    let state = app.state::<State>();
    let items = state.0.lock().map_err(|_| "Language unavailable")?;
    let labels: Result<Vec<_>, _> = items.iter().map(|i| i.text()).collect();
    Ok(serde_json::json!({"language":language,"trayLabels":labels.map_err(|e|e.to_string())?}))
}
