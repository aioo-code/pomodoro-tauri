use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::PathBuf};
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, WebviewWindow};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Accent {
    #[default]
    Tomato,
    Blue,
    Teal,
    Green,
    Violet,
    Rose,
    Amber,
    CandyPink,
    CandyPurple,
    CandyBlue,
    CandyOrange,
    CandyLime,
    Black,
    White,
    Custom,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TimerStyle {
    #[default]
    Comet,
    Arc,
    Orbit,
    Ticks,
    Digits,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Position {
    TopLeft,
    TopRight,
    Center,
    BottomLeft,
    #[default]
    BottomRight,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NoiseTexture {
    #[default]
    #[serde(alias = "soft")]
    Still,
    #[serde(alias = "rain")]
    Space,
    #[serde(alias = "ocean")]
    Bowl,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    #[default]
    Down,
    Up,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub language: crate::i18n::Language,
    pub direction: Direction,
    pub number_animation: bool,
    pub accent: Accent,
    pub custom_accent: String,
    pub timer_style: TimerStyle,
    pub position: Position,
    pub always_on_top: bool,
    pub reduce_motion: bool,
    pub acrylic: bool,
    pub icon: crate::icons::Choice,
    pub corner_radius: u8,
    pub durations: Vec<DurationPreset>,
    pub quotes_enabled: bool,
    pub quotes: Vec<QuoteEntry>,
    pub mini_opacity: u8,
    pub dim_inactive: bool,
    pub snap_to_edges: bool,
    pub interaction_sounds: bool,
    pub audio_muted: bool,
    pub interaction_volume: u8,
    pub reminder_noise: bool,
    pub noise_texture: NoiseTexture,
    pub noise_volume: u8,
    pub custom_noise_id: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DurationPreset {
    pub id: String,
    pub label: String,
    pub minutes: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuoteEntry {
    pub id: String,
    pub text: String,
}
fn default_quotes() -> Vec<QuoteEntry> {
    [
        "先做好眼前这一小步。",
        "把注意力，交给此刻。",
        "慢一点，也在向前。",
        "让行动先于犹豫。",
        "专注当下，日有所进。",
        "把今天的坚持，留给明天的自己。",
    ]
    .into_iter()
    .enumerate()
    .map(|(index, text)| QuoteEntry {
        id: format!("gentle-{}", index + 1),
        text: text.into(),
    })
    .collect()
}

fn default_durations() -> Vec<DurationPreset> {
    [5, 10, 15, 25, 30, 45, 60]
        .into_iter()
        .map(|minutes| DurationPreset {
            id: format!("default-{minutes}"),
            label: format!("{minutes}分钟"),
            minutes,
        })
        .collect()
}

impl Preferences {
    fn validate(&self) -> Result<(), String> {
        if self.quotes.len() > 50 {
            return Err("最多保存 50 条语录。".into());
        }
        let mut quote_ids = std::collections::HashSet::new();
        for quote in &self.quotes {
            if quote.id.is_empty()
                || quote.id.len() > 64
                || !quote
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
                || !quote_ids.insert(&quote.id)
            {
                return Err("语录标识无效或重复。".into());
            }
            if quote.text.trim().is_empty()
                || quote.text.chars().count() > 120
                || quote.text.chars().any(char::is_control)
            {
                return Err("语录请使用 1–120 个字，不含控制字符。".into());
            }
        }
        if self.custom_accent.len() != 7
            || !self.custom_accent.starts_with('#')
            || !self.custom_accent.as_bytes()[1..]
                .iter()
                .all(u8::is_ascii_hexdigit)
        {
            return Err("主题色请使用 #RRGGBB 格式。".into());
        }
        if !self.custom_noise_id.is_empty()
            && (self.custom_noise_id.len() != 36
                || !self
                    .custom_noise_id
                    .bytes()
                    .enumerate()
                    .all(|(index, byte)| {
                        if [8, 13, 18, 23].contains(&index) {
                            byte == b'-'
                        } else {
                            byte.is_ascii_hexdigit()
                        }
                    }))
        {
            return Err("自定义声音标识无效。".into());
        }
        if self.interaction_volume > 100 || self.noise_volume > 100 {
            return Err("音量请设置为 0–100%。".into());
        }
        if !(30..=100).contains(&self.mini_opacity) {
            return Err("小窗不透明度请设置为 30–100%。".into());
        }
        if self.corner_radius > 32 {
            return Err("圆角请设置为 0–32。".into());
        }
        if self.durations.len() > 24 {
            return Err("最多保存 24 个常用时长。".into());
        }
        let mut ids = std::collections::HashSet::new();
        let mut minutes = std::collections::HashSet::new();
        for preset in &self.durations {
            if preset.id.is_empty()
                || preset.id.len() > 64
                || !preset
                    .id
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
            {
                return Err("时长标识无效。".into());
            }
            if preset.label.trim().is_empty() || preset.label.chars().count() > 20 {
                return Err("时长名称请使用 1–20 个字。".into());
            }
            if !(1..=1440).contains(&preset.minutes) {
                return Err("时长请使用 1–1440 的整数分钟。".into());
            }
            if !ids.insert(&preset.id) || !minutes.insert(preset.minutes) {
                return Err("列表中已存在相同的时长。".into());
            }
        }
        Ok(())
    }
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            language: crate::i18n::Language::default(),
            direction: Direction::Down,
            number_animation: true,
            accent: Accent::Tomato,
            custom_accent: "#9a64ff".into(),
            timer_style: TimerStyle::Comet,
            position: Position::BottomRight,
            always_on_top: true,
            reduce_motion: false,
            acrylic: true,
            icon: crate::icons::Choice::Flow,
            corner_radius: 20,
            durations: default_durations(),
            quotes_enabled: true,
            quotes: default_quotes(),
            mini_opacity: 100,
            dim_inactive: true,
            snap_to_edges: true,
            interaction_sounds: true,
            audio_muted: false,
            interaction_volume: 28,
            reminder_noise: true,
            noise_texture: NoiseTexture::Still,
            noise_volume: 22,
            custom_noise_id: String::new(),
        }
    }
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Patch {
    language: Option<crate::i18n::Language>,
    direction: Option<Direction>,
    number_animation: Option<bool>,
    accent: Option<Accent>,
    custom_accent: Option<String>,
    timer_style: Option<TimerStyle>,
    position: Option<Position>,
    always_on_top: Option<bool>,
    reduce_motion: Option<bool>,
    acrylic: Option<bool>,
    icon: Option<crate::icons::Choice>,
    corner_radius: Option<u8>,
    durations: Option<Vec<DurationPreset>>,
    quotes_enabled: Option<bool>,
    quotes: Option<Vec<QuoteEntry>>,
    mini_opacity: Option<u8>,
    dim_inactive: Option<bool>,
    snap_to_edges: Option<bool>,
    interaction_sounds: Option<bool>,
    audio_muted: Option<bool>,
    interaction_volume: Option<u8>,
    reminder_noise: Option<bool>,
    noise_texture: Option<NoiseTexture>,
    noise_volume: Option<u8>,
    custom_noise_id: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub values: Preferences,
    pub load_error: Option<String>,
}

pub struct Store {
    path: PathBuf,
    pub values: Preferences,
    load_error: Option<String>,
}

impl Store {
    pub fn open(path: PathBuf) -> Self {
        match fs::read(&path) {
            Ok(bytes) => {
                match serde_json::from_slice::<serde_json::Value>(&bytes).and_then(|mut input| {
                    if let Some(settings) = input.as_object_mut() {
                        settings.remove("showRecording");
                    }
                    let values = serde_json::from_value::<Preferences>(input)?;
                    values.validate().map_err(serde::de::Error::custom)?;
                    Ok(values)
                }) {
                    Ok(values) => Self {
                        path,
                        values,
                        load_error: None,
                    },
                    Err(_) => Self {
                        path,
                        values: Preferences::default(),
                        load_error: Some(
                            "保存的设置无法解析，暂用默认值。再次保存前会保留原文件副本。".into(),
                        ),
                    },
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Self {
                path,
                values: Preferences::default(),
                load_error: None,
            },
            Err(_) => Self {
                path,
                values: Preferences::default(),
                load_error: Some("保存的设置暂时无法读取，正在使用默认值。".into()),
            },
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            values: self.values.clone(),
            load_error: self.load_error.clone(),
        }
    }

    pub fn save(&mut self, values: Preferences) -> Result<(), String> {
        values.validate()?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if self.load_error.is_some() && self.path.exists() {
            let backup = self
                .path
                .with_extension(format!("invalid-{}.json", std::process::id()));
            if !backup.exists() {
                fs::copy(&self.path, &backup).map_err(|e| e.to_string())?;
            }
        }
        let pending = self.path.with_extension("pending");
        let mut file = fs::File::create(&pending).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec_pretty(&values).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&pending, &self.path).map_err(|e| e.to_string())?;
        self.values = values;
        self.load_error = None;
        Ok(())
    }
}

pub struct State(pub std::sync::Mutex<Store>);

fn coordinates(
    position: Position,
    area: (i32, i32, u32, u32),
    size: (u32, u32),
    margin: i32,
) -> (i32, i32) {
    let (left, top, width, height) = area;
    let right = (left + width as i32 - size.0 as i32).max(left);
    let bottom = (top + height as i32 - size.1 as i32).max(top);
    let (x, y) = match position {
        Position::TopLeft => (left + margin, top + margin),
        Position::TopRight => (right - margin, top + margin),
        Position::Center => (
            left + (width as i32 - size.0 as i32) / 2,
            top + (height as i32 - size.1 as i32) / 2,
        ),
        Position::BottomLeft => (left + margin, bottom - margin),
        Position::BottomRight => (right - margin, bottom - margin),
    };
    (x.clamp(left, right), y.clamp(top, bottom))
}

pub fn place(window: &WebviewWindow, position: Position) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or(window.primary_monitor().map_err(|e| e.to_string())?)
        .ok_or("无法取得屏幕工作区。")?;
    let area = monitor.work_area();
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let (x, y) = coordinates(
        position,
        (
            area.position.x,
            area.position.y,
            area.size.width,
            area.size.height,
        ),
        (size.width, size.height),
        (24.0 * monitor.scale_factor()).round() as i32,
    );
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_preferences(app: AppHandle) -> Result<Snapshot, String> {
    app.state::<State>()
        .0
        .lock()
        .map(|store| store.snapshot())
        .map_err(|_| "设置暂时不可用。".into())
}

#[tauri::command]
pub fn set_preferences(
    app: AppHandle,
    window: WebviewWindow,
    patch: Patch,
) -> Result<Snapshot, String> {
    if window.label() != "main" {
        return Err("请在主窗口中修改设置。".into());
    }
    let main = crate::main_window(&app)?;
    let desktop = app.state::<crate::Desktop>();
    let data = desktop.0.lock().map_err(|_| "窗口状态暂时不可用。")?;
    if data.mini
        && (patch.number_animation.is_some()
            || patch.direction.is_some()
            || patch.language.is_some()
            || patch.accent.is_some()
            || patch.custom_accent.is_some()
            || patch.timer_style.is_some()
            || patch.position.is_some()
            || patch.always_on_top.is_some()
            || patch.reduce_motion.is_some()
            || patch.acrylic.is_some()
            || patch.icon.is_some()
            || patch.corner_radius.is_some()
            || patch.durations.is_some()
            || patch.quotes_enabled.is_some()
            || patch.quotes.is_some())
    {
        return Err("请恢复主窗口后修改设置。".into());
    }
    let state = app.state::<State>();
    let mut store = state.0.lock().map_err(|_| "设置暂时不可用。")?;
    let mut next = store.values.clone();
    if let Some(v) = patch.language {
        next.language = v;
    }
    if let Some(v) = patch.direction {
        next.direction = v;
    }
    if let Some(v) = patch.number_animation {
        next.number_animation = v;
    }
    if let Some(v) = patch.accent {
        next.accent = v;
    }
    if let Some(v) = patch.custom_accent {
        next.custom_accent = v;
    }
    if let Some(v) = patch.timer_style {
        next.timer_style = v;
    }
    if let Some(v) = patch.position {
        next.position = v;
    }
    if let Some(v) = patch.always_on_top {
        next.always_on_top = v;
    }
    if let Some(v) = patch.reduce_motion {
        next.reduce_motion = v;
    }
    if let Some(v) = patch.acrylic {
        next.acrylic = v;
    }
    if let Some(v) = patch.icon {
        next.icon = v;
    }
    if let Some(v) = patch.corner_radius {
        next.corner_radius = v;
    }
    if let Some(v) = patch.durations {
        next.durations = v;
    }
    if let Some(v) = patch.quotes_enabled {
        next.quotes_enabled = v;
    }
    if let Some(v) = patch.quotes {
        next.quotes = v;
    }
    if let Some(v) = patch.mini_opacity {
        next.mini_opacity = v;
    }
    if let Some(v) = patch.dim_inactive {
        next.dim_inactive = v;
    }
    if let Some(v) = patch.snap_to_edges {
        next.snap_to_edges = v;
    }
    if let Some(v) = patch.interaction_sounds {
        next.interaction_sounds = v;
    }
    if let Some(v) = patch.audio_muted {
        next.audio_muted = v;
    }
    if let Some(v) = patch.interaction_volume {
        next.interaction_volume = v;
    }
    if let Some(v) = patch.reminder_noise {
        next.reminder_noise = v;
    }
    if let Some(v) = patch.noise_texture {
        next.noise_texture = v;
    }
    if let Some(v) = patch.noise_volume {
        next.noise_volume = v;
    }
    if let Some(v) = patch.custom_noise_id {
        next.custom_noise_id = v;
    }
    next.validate()?;
    let previous_position = main.outer_position().map_err(|e| e.to_string())?;
    let previous_pin = main.is_always_on_top().map_err(|e| e.to_string())?;
    let operation = (|| {
        if patch.always_on_top.is_some() {
            main.set_always_on_top(next.always_on_top)
                .map_err(|e| e.to_string())?;
        }
        if patch.position.is_some() {
            place(&main, next.position)?;
        }
        if patch.corner_radius.is_some() {
            crate::material::set_corners(&app, next.corner_radius)?;
        }
        if patch.acrylic.is_some() {
            crate::material::apply_preferences(&app, next.acrylic, next.corner_radius)?;
        }
        crate::widget::apply(&main, data.mini, &next)?;
        if patch.icon.is_some() {
            crate::icons::apply(&app, next.icon)?;
        }
        store.save(next)
    })();
    if let Err(error) = operation {
        if patch.icon.is_some() {
            let _ = crate::icons::apply(&app, store.values.icon);
        }
        if patch.acrylic.is_some() {
            let _ = crate::material::apply_preferences(
                &app,
                store.values.acrylic,
                store.values.corner_radius,
            );
        }
        let _ = crate::widget::apply(&main, data.mini, &store.values);
        if patch.position.is_some() {
            let _ = main.set_position(previous_position);
        }
        if patch.always_on_top.is_some() {
            let _ = main.set_always_on_top(previous_pin);
        }
        if patch.corner_radius.is_some() {
            let _ = crate::material::set_corners(&app, store.values.corner_radius);
        }
        return Err(format!("设置未能保存：{error}"));
    }
    let snapshot = store.snapshot();
    drop(store);
    drop(data);
    if patch.audio_muted.is_some() {
        crate::audio::apply_muted(&app, snapshot.values.audio_muted);
    }
    if let Err(error) = crate::i18n::refresh(&app) {
        eprintln!("Language update: {error}");
    }
    if let Err(error) = app.emit("preferences-changed", snapshot.clone()) {
        eprintln!("Appearance broadcast: {error}");
    }
    Ok(snapshot)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReminderAudioPatch {
    noise_volume: Option<u8>,
    noise_texture: Option<NoiseTexture>,
    custom_noise_id: Option<String>,
}

#[tauri::command]
pub fn set_reminder_audio(
    app: AppHandle,
    window: WebviewWindow,
    patch: ReminderAudioPatch,
) -> Result<Snapshot, String> {
    if window.label() != "reminder" {
        return Err("Only reminder audio can be changed here".into());
    }
    let state = app.state::<State>();
    let mut store = state.0.lock().map_err(|_| "设置暂时不可用。")?;
    let mut next = store.values.clone();
    if let Some(value) = patch.noise_volume {
        next.noise_volume = value;
    }
    if let Some(value) = patch.noise_texture {
        next.noise_texture = value;
    }
    if let Some(value) = patch.custom_noise_id {
        next.custom_noise_id = value;
    }
    store.save(next)?;
    let snapshot = store.snapshot();
    drop(store);
    app.emit("preferences-changed", snapshot.clone())
        .map_err(|error| error.to_string())?;
    Ok(snapshot)
}

pub fn sync_reminder(app: &AppHandle) -> Result<(), String> {
    let snapshot = get_preferences(app.clone())?;
    app.emit_to("reminder", "preferences-changed", snapshot)
        .map_err(|error| error.to_string())
}

pub fn patch_widget(
    app: &AppHandle,
    opacity: Option<u8>,
    dim: Option<bool>,
    snap: Option<bool>,
) -> Result<(), String> {
    set_preferences(
        app.clone(),
        crate::main_window(app)?,
        Patch {
            mini_opacity: opacity,
            dim_inactive: dim,
            snap_to_edges: snap,
            ..Patch::default()
        },
    )
    .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prior_preferences_keep_local_values() {
        let root = PathBuf::from(std::env::var_os("POMODORO_TOOL_TEST_ROOT").unwrap());
        let path = root.join(format!("old-settings-{}.json", uuid::Uuid::new_v4()));
        fs::write(&path, br#"{"direction":"up","showRecording":true}"#).unwrap();
        let store = Store::open(path);
        assert_eq!(store.values.direction, Direction::Up);
        assert!(store.snapshot().load_error.is_none());
    }
    #[test]
    fn custom_appearance_and_sound_migrate_persist_and_reject_invalid_writes() {
        assert_eq!(Preferences::default().accent, Accent::Tomato);
        assert_eq!(
            serde_json::from_str::<Preferences>(r#"{"accent":"blue"}"#)
                .unwrap()
                .accent,
            Accent::Blue
        );
        let old_icon: crate::icons::Choice = serde_json::from_str(r#""tomato""#).unwrap();
        assert_eq!(old_icon, crate::icons::Choice::Flow);
        assert_eq!(serde_json::to_string(&old_icon).unwrap(), r#""flow""#);
        let legacy: Preferences = serde_json::from_str(r#"{"accent":"violet"}"#).unwrap();
        assert!(legacy.quotes_enabled);
        assert_eq!(legacy.quotes.len(), 6);
        let mut empty_quotes = legacy.clone();
        empty_quotes.quotes.clear();
        assert!(empty_quotes.validate().is_ok());
        let mut invalid_quotes = legacy.clone();
        invalid_quotes.quotes[0].text = " ".into();
        assert!(invalid_quotes.validate().is_err());
        assert_eq!(legacy.timer_style, TimerStyle::Comet);
        assert_eq!(legacy.custom_accent, "#9a64ff");
        assert!(legacy.custom_noise_id.is_empty());
        let path = PathBuf::from(std::env::var_os("POMODORO_TOOL_TEST_ROOT").unwrap())
            .join(format!("custom-{}.json", uuid::Uuid::new_v4()));
        let mut store = Store::open(path.clone());
        let mut next = legacy;
        next.accent = Accent::Custom;
        next.custom_accent = "#fF1aB0".into();
        next.custom_noise_id = "51c22807-9bf1-4001-8eef-493c1b99d219".into();
        for style in [
            TimerStyle::Comet,
            TimerStyle::Arc,
            TimerStyle::Orbit,
            TimerStyle::Ticks,
            TimerStyle::Digits,
        ] {
            next.timer_style = style;
            store.save(next.clone()).unwrap();
            assert_eq!(Store::open(path.clone()).values, next);
        }
        let bytes = fs::read(&path).unwrap();
        for invalid in ["red", "#abc", "#00000g", "#ff0011\n", "#颜色色"] {
            let mut invalid_next = next.clone();
            invalid_next.custom_accent = invalid.into();
            assert!(store.save(invalid_next).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        for invalid in [
            "../outside",
            "51c22807-9bf1-4001-8eef-493c1b99d21g",
            "51c228079bf140018eef493c1b99d219",
        ] {
            let mut invalid_next = next.clone();
            invalid_next.custom_noise_id = invalid.into();
            assert!(store.save(invalid_next).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        assert!(serde_json::from_str::<Patch>(r#"{"timerStyle":"unknown"}"#).is_err());
        let reminder: ReminderAudioPatch = serde_json::from_str(r#"{"customNoiseId":""}"#).unwrap();
        assert_eq!(reminder.custom_noise_id, Some(String::new()));
        next.custom_noise_id.clear();
        store.save(next.clone()).unwrap();
        assert_eq!(Store::open(path).values, next);
    }
    #[test]
    fn legacy_audio_defaults_and_invalid_audio_never_overwrite_preferences() {
        for (old, expected) in [
            ("soft", NoiseTexture::Still),
            ("rain", NoiseTexture::Space),
            ("ocean", NoiseTexture::Bowl),
        ] {
            let migrated: Preferences =
                serde_json::from_value(serde_json::json!({"noiseTexture":old,"noiseVolume":37}))
                    .unwrap();
            assert_eq!(migrated.noise_texture, expected);
            assert_eq!(migrated.noise_volume, 37);
            assert_ne!(serde_json::to_value(migrated).unwrap()["noiseTexture"], old);
        }
        let legacy: Preferences = serde_json::from_str(r#"{"accent":"rose"}"#).unwrap();
        assert!(legacy.interaction_sounds && legacy.reminder_noise);
        assert!(!legacy.audio_muted);
        assert_eq!((legacy.interaction_volume, legacy.noise_volume), (28, 22));
        assert_eq!(legacy.noise_texture, NoiseTexture::Still);
        let path = PathBuf::from(std::env::var_os("POMODORO_TOOL_TEST_ROOT").unwrap())
            .join(format!("audio-{}.json", uuid::Uuid::new_v4()));
        let mut store = Store::open(path.clone());
        let mut next = legacy;
        next.noise_texture = NoiseTexture::Bowl;
        next.interaction_sounds = false;
        next.audio_muted = true;
        next.noise_volume = 0;
        store.save(next.clone()).unwrap();
        assert_eq!(Store::open(path.clone()).values, next);
        let bytes = fs::read(&path).unwrap();
        next.interaction_volume = 101;
        assert!(store.save(next.clone()).is_err());
        next.interaction_volume = 0;
        next.noise_volume = 101;
        assert!(store.save(next).is_err());
        assert_eq!(fs::read(path).unwrap(), bytes);
        assert!(serde_json::from_str::<ReminderAudioPatch>(r#"{"cornerRadius":0}"#).is_err());
        assert!(serde_json::from_str::<ReminderAudioPatch>(r#"{"noiseTexture":"storm"}"#).is_err());
    }
    #[test]
    fn previous_settings_migrate_and_invalid_lists_cannot_overwrite_saved_preferences() {
        let previous: Preferences =
            serde_json::from_str(r#"{"accent":"rose","alwaysOnTop":false}"#).unwrap();
        assert_eq!(previous.corner_radius, 20);
        assert_eq!(previous.durations.len(), 7);
        assert!(!previous.always_on_top);
        let path = PathBuf::from(
            std::env::var_os("POMODORO_TOOL_TEST_ROOT").expect("task-owned test root"),
        )
        .join(format!("durations-{}.json", uuid::Uuid::new_v4()));
        let mut store = Store::open(path.clone());
        store.save(previous).unwrap();
        let bytes = fs::read(&path).unwrap();
        let mut duplicate = store.values.clone();
        duplicate.durations.push(duplicate.durations[0].clone());
        assert!(store.save(duplicate).is_err());
        assert_eq!(fs::read(&path).unwrap(), bytes);
        let mut next = store.values.clone();
        next.durations = vec![DurationPreset {
            id: "reading".into(),
            label: "阅读".into(),
            minutes: 17,
        }];
        next.corner_radius = 0;
        store.save(next.clone()).unwrap();
        assert_eq!(Store::open(path).values, next);
    }
    #[test]
    fn corner_placement_handles_negative_monitors_and_tiny_work_areas() {
        assert_eq!(
            coordinates(
                Position::BottomRight,
                (-1920, -100, 1920, 1080),
                (600, 780),
                36
            ),
            (-636, 164)
        );
        assert_eq!(
            coordinates(Position::Center, (0, 0, 300, 200), (600, 780), 24),
            (0, 0)
        );
    }
    #[test]
    fn saved_preferences_survive_restart_and_invalid_files_are_preserved() {
        let path = PathBuf::from(
            std::env::var_os("POMODORO_TOOL_TEST_ROOT").expect("task-owned test root"),
        )
        .join(format!("preferences-{}.json", uuid::Uuid::new_v4()));
        let mut store = Store::open(path.clone());
        assert!(store.values.always_on_top);
        assert_eq!(store.values.position, Position::BottomRight);
        let mut values = store.values.clone();
        values.accent = Accent::Rose;
        values.always_on_top = false;
        store.save(values.clone()).unwrap();
        assert_eq!(Store::open(path.clone()).values, values);
        fs::write(&path, b"invalid settings").unwrap();
        let mut store = Store::open(path.clone());
        assert!(store.snapshot().load_error.is_some());
        store.save(Preferences::default()).unwrap();
        assert_eq!(
            fs::read(path.with_extension(format!("invalid-{}.json", std::process::id()))).unwrap(),
            b"invalid settings"
        );
    }
}
