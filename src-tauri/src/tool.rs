//! Shared timer controller for the desktop and local CLI.
use crate::request_log::{Reply, Request, RequestLog, ToolError, REQUEST_SCHEMA};
use crate::timer::{Mode, Snapshot, Status, Timer};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, time::Instant};

const APP_VERSION: &str = match option_env!("POMODORO_BUILD_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

fn failure(code: &str, message: &str) -> ToolError {
    ToolError::new(code, message, "failed")
}

fn io_error(error: impl std::fmt::Display) -> ToolError {
    failure("tool_state_unavailable", &error.to_string())
}

pub struct Controller {
    timer: Timer,
    requests: Option<RequestLog>,
    qa: bool,
    pub completion_pending: Option<Mode>,
}

impl Controller {
    pub fn open_with_recovery(
        seconds: Option<u64>,
        directory: PathBuf,
        qa: bool,
        recover_legacy: bool,
        simulate_legacy_owner: bool,
    ) -> Result<Self, ToolError> {
        if !directory.is_absolute() {
            return Err(failure(
                "invalid_tool_root",
                "Tool data directory must be absolute",
            ));
        }
        // Packaged Windows launchers can virtualize AppData without reparse points.
        // Reject real links first, then retain the actual kernel-resolved data root.
        for ancestor in directory.ancestors() {
            if let Ok(metadata) = fs::symlink_metadata(ancestor) {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes() & 0x400 != 0 {
                        return Err(failure(
                            "resource_path_rejected",
                            "Tool data directory contains a reparse point",
                        ));
                    }
                }
                if metadata.file_type().is_symlink() {
                    return Err(failure(
                        "resource_path_rejected",
                        "Tool data directory contains a link",
                    ));
                }
            }
        }
        fs::create_dir_all(
            directory
                .parent()
                .ok_or_else(|| io_error("data directory has no parent"))?,
        )
        .map_err(io_error)?;
        // Resolve the parent, including packaged AppData virtualization, without
        // pre-creating the private leaf with the elevated token's default owner.
        let directory = fs::canonicalize(directory.parent().unwrap())
            .map_err(io_error)?
            .join(
                directory
                    .file_name()
                    .ok_or_else(|| io_error("data directory has no name"))?,
            );
        if recover_legacy {
            if let Some(backup) = crate::private_directory::recover_empty_legacy_root(
                &directory,
                simulate_legacy_owner,
            )
            .map_err(io_error)?
            {
                eprintln!("已备份旧版空目录：{}", backup.display());
            }
        }
        let requests = RequestLog::open(directory).map_err(io_error)?;
        Ok(Self {
            timer: Timer::new(seconds),
            requests: Some(requests),
            qa,
            completion_pending: None,
        })
    }

    pub fn tick(&mut self, now: Instant) {
        let mode = self.timer.snapshot().mode;
        if self.timer.tick(now) {
            self.completion_pending = Some(mode);
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        self.timer.snapshot()
    }

    pub fn request(&mut self, request: &Request) -> Reply {
        let log = self
            .requests
            .take()
            .expect("timer operations do not reenter the request log");
        let reply = log.execute(request, || self.dispatch(request));
        self.requests = Some(log);
        reply
    }

    pub fn operation(&self, id: &str) -> Value {
        match self
            .requests
            .as_ref()
            .expect("query outside request execution")
            .operation(id)
        {
            Ok(reply) => json!({"ok":true,"data":reply}),
            Err(error) => json!({"ok":false,"error":io_error(error)}),
        }
    }
    fn dispatch(&mut self, request: &Request) -> Result<Value, ToolError> {
        self.tick(Instant::now());
        let before = self.snapshot();
        if let Some(expected) = request.expected_revision {
            if expected != before.revision {
                return Err(ToolError::new(
                    "version_conflict",
                    "State changed; read snapshot before issuing a new request",
                    "denied",
                ));
            }
        }
        match request.operation.as_str() {
            "describe" => {
                return Ok(
                    json!({"schema":"cosy.tool.description/1","tool_id":"pomodoro","version":APP_VERSION,"operations":["describe","snapshot","operation","set_mode","set_minutes","adjust_remaining","start","pause","resume","reset"],"identity_scope":"current_OS_account_only","qa":self.qa}),
                )
            }
            "snapshot" => return Ok(json!({"clock":before})),
            "operation" => {
                return Err(failure(
                    "invalid_request",
                    "operation queries are handled outside the mutation lane",
                ))
            }
            "set_minutes" => {
                let minutes = request
                    .params
                    .get("minutes")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| failure("argument_invalid", "minutes required"))?;
                self.timer
                    .set_minutes(minutes)
                    .map_err(|m| failure("argument_invalid", m))?;
            }
            "adjust_remaining" => {
                if request
                    .params
                    .get("mode")
                    .and_then(Value::as_str)
                    .is_some_and(|mode| {
                        mode != if before.mode == Mode::Focus {
                            "focus"
                        } else {
                            "break"
                        }
                    })
                {
                    return Err(failure(
                        "version_conflict",
                        "Timer mode changed during adjustment",
                    ));
                }
                let milliseconds = request
                    .params
                    .get("milliseconds")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| failure("argument_invalid", "milliseconds required"))?;
                self.timer
                    .adjust_remaining(milliseconds, Instant::now())
                    .map_err(|m| failure("argument_invalid", m))?;
            }
            "set_mode" => {
                let mode = request
                    .params
                    .get("mode")
                    .and_then(Value::as_str)
                    .filter(|m| ["focus", "break"].contains(m))
                    .ok_or_else(|| failure("argument_invalid", "mode must be focus or break"))?;
                self.timer
                    .action(mode, Instant::now())
                    .map_err(|m| failure("argument_invalid", m))?;
            }
            "start" | "pause" | "resume" | "reset" => {
                let operation = request.operation.as_str();
                if operation == "resume" && before.status != Status::Paused {
                    return Err(failure("invalid_state", "resume requires paused state"));
                }
                let action = if operation == "resume" {
                    "start"
                } else {
                    operation
                };
                self.timer
                    .action(action, Instant::now())
                    .map_err(|m| failure("argument_invalid", m))?;
            }
            _ => {
                return Err(ToolError::new(
                    "unsupported",
                    "Unknown tool operation",
                    "denied",
                ))
            }
        }
        Ok(json!({"clock":self.snapshot()}))
    }
    pub fn gui_action(&mut self, action: &str) -> Result<Snapshot, String> {
        self.tick(Instant::now());
        let (operation, params) = if let Some(value) = action.strip_prefix("remaining:") {
            let (mode, milliseconds) = value.split_once(':').ok_or("时间参数无效。")?;
            (
                "adjust_remaining",
                json!({"mode":mode,"milliseconds":milliseconds.parse::<u64>().map_err(|_|"时间参数无效。")?}),
            )
        } else if let Some(minutes) = action.strip_prefix("minutes:") {
            (
                "set_minutes",
                json!({"minutes":minutes.parse::<u64>().map_err(|_|"请选择提供的快捷时长。")?}),
            )
        } else if ["focus", "break"].contains(&action) {
            ("set_mode", json!({"mode":action}))
        } else if action == "toggle" {
            (
                if self.snapshot().status == Status::Running {
                    "pause"
                } else {
                    "start"
                },
                json!({}),
            )
        } else {
            (action, json!({}))
        };
        let request = Request {
            schema: REQUEST_SCHEMA.into(),
            id: String::new(),
            operation: operation.into(),
            params,
            expected_revision: None,
        };
        self.dispatch(&request)
            .map(|_| self.snapshot())
            .map_err(|error| error.message)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn controller(name: &str) -> Controller {
        let root = PathBuf::from(std::env::var_os("POMODORO_TOOL_TEST_ROOT").unwrap());
        Controller::open_with_recovery(
            Some(2),
            root.join(format!("{name}-{}", uuid::Uuid::new_v4())),
            true,
            false,
            false,
        )
        .unwrap()
    }
    fn request(id: &str, operation: &str, params: Value) -> Request {
        Request {
            schema: REQUEST_SCHEMA.into(),
            id: id.into(),
            operation: operation.into(),
            params,
            expected_revision: None,
        }
    }
    #[test]
    fn duplicate_request_never_repeats_timer_reset() {
        let mut c = controller("dedup");
        let r = request("start", "start", json!({}));
        let first = c.request(&r);
        c.timer
            .tick(Instant::now() + std::time::Duration::from_secs(1));
        assert_eq!(
            serde_json::to_value(c.request(&r)).unwrap(),
            serde_json::to_value(first).unwrap()
        );
        assert!(c.snapshot().remaining_ms <= 1000);
        assert!(!c.request(&request("start", "reset", json!({}))).ok);
    }
    #[test]
    fn stale_revision_does_not_mutate_timer() {
        let mut c = controller("cas");
        c.request(&request("one", "start", json!({})));
        let mut r = request("two", "reset", json!({}));
        r.expected_revision = Some(0);
        assert_eq!(c.request(&r).error.unwrap().code, "version_conflict");
        assert_eq!(c.snapshot().status, Status::Running);
    }
}
