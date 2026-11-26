use chrono::{Days, Local, NaiveDate};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, io::Write, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Data {
    days: BTreeMap<String, u32>,
}
pub struct Store {
    path: PathBuf,
    data: Data,
    dirty: bool,
    error: Option<String>,
}
pub struct State(pub Mutex<Store>);
#[derive(Serialize)]
pub struct Day {
    date: String,
    count: u32,
}
#[derive(Serialize)]
pub struct Snapshot {
    days: Vec<Day>,
    error: Option<String>,
}

impl Store {
    pub fn open(path: PathBuf) -> Self {
        let result = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice::<Data>(&bytes).map_err(|_| ()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Data::default()),
            Err(_) => Err(()),
        };
        match result {
            Ok(data)
                if data
                    .days
                    .keys()
                    .all(|key| NaiveDate::parse_from_str(key, "%Y-%m-%d").is_ok()) =>
            {
                Self {
                    path,
                    data,
                    dirty: false,
                    error: None,
                }
            }
            _ => Self {
                path,
                data: Data::default(),
                dirty: false,
                error: Some("使用记录暂时不可用".into()),
            },
        }
    }
    fn persist(&mut self) -> Result<(), String> {
        if !self.dirty {
            return Ok(());
        }
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let pending = self.path.with_extension("pending");
        let mut file = fs::File::create(&pending).map_err(|e| e.to_string())?;
        file.write_all(&serde_json::to_vec(&self.data).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(pending, &self.path).map_err(|e| e.to_string())?;
        self.dirty = false;
        self.error = None;
        Ok(())
    }
    fn record(&mut self, date: NaiveDate) -> Result<(), String> {
        // An unreadable file is retained intact instead of overwriting history.
        if self.error.is_some() && !self.dirty {
            return Err("使用记录暂时不可用".into());
        }
        let count = self.data.days.entry(date.to_string()).or_default();
        *count = count.saturating_add(1);
        // Keep ten years, without retaining individual sessions or task names.
        while self.data.days.len() > 3660 {
            self.data.days.pop_first();
        }
        self.dirty = true;
        let result = self.persist();
        if result.is_err() {
            self.error = Some("使用记录暂时不可用".into());
        }
        result
    }
    fn snapshot(&mut self, today: NaiveDate) -> Snapshot {
        if self.dirty {
            let _ = self.persist();
        }
        Snapshot {
            days: (0..30)
                .rev()
                .map(|offset| {
                    let date = today
                        .checked_sub_days(Days::new(offset))
                        .unwrap_or(today)
                        .to_string();
                    Day {
                        count: self.data.days.get(&date).copied().unwrap_or(0),
                        date,
                    }
                })
                .collect(),
            error: self.error.clone(),
        }
    }
}

pub fn completed(app: &AppHandle, mode: crate::timer::Mode) {
    if mode != crate::timer::Mode::Focus {
        return;
    }
    if let Some(state) = app.try_state::<State>() {
        if let Ok(mut store) = state.0.lock() {
            if let Err(error) = store.record(Local::now().date_naive()) {
                eprintln!("Usage history: {error}");
            }
        }
        let _ = app.emit("usage-changed", ());
    }
}

#[tauri::command]
pub fn usage_snapshot(app: AppHandle) -> Result<Snapshot, String> {
    app.state::<State>()
        .0
        .lock()
        .map_err(|_| "使用记录暂时不可用".to_owned())
        .map(|mut store| store.snapshot(Local::now().date_naive()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_local_days_and_survives_restart() {
        let root = std::env::var_os("POMODORO_TOOL_TEST_ROOT").expect("task-owned test root");
        let file = PathBuf::from(root).join("usage-restart.json");
        let today = NaiveDate::from_ymd_opt(2026, 3, 1).unwrap();
        let mut store = Store::open(file.clone());
        store.record(today).unwrap();
        store.record(today).unwrap();
        store.record(today.pred_opt().unwrap()).unwrap();
        let mut restored = Store::open(file);
        let snapshot = restored.snapshot(today);
        assert_eq!(snapshot.days.len(), 30);
        assert_eq!(snapshot.days[29].date, "2026-03-01");
        assert_eq!(snapshot.days[29].count, 2);
        assert_eq!(snapshot.days[28].count, 1);
        assert_eq!(snapshot.days[0].count, 0);
    }
    #[test]
    fn damaged_history_is_never_overwritten() {
        let root = std::env::var_os("POMODORO_TOOL_TEST_ROOT").expect("task-owned test root");
        let file = PathBuf::from(root).join("usage-damaged.json");
        fs::write(&file, b"broken historical file").unwrap();
        let mut store = Store::open(file.clone());
        let date = NaiveDate::from_ymd_opt(2026, 1, 1).unwrap();
        assert!(store.record(date).is_err());
        assert!(store.snapshot(date).error.is_some());
        assert_eq!(fs::read(file).unwrap(), b"broken historical file");
    }
}
