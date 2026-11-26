use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

pub const REQUEST_SCHEMA: &str = "cosy.tool.request/1";
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_RECEIPT_BYTES: usize = 8 * MAX_REQUEST_BYTES;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub schema: String,
    pub id: String,
    pub operation: String,
    #[serde(default = "empty_params")]
    pub params: Value,
    #[serde(default)]
    pub expected_revision: Option<u64>,
}

fn empty_params() -> Value {
    json!({})
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ToolError {
    pub code: String,
    pub message: String,
    pub outcome: String,
}

impl ToolError {
    pub fn new(code: &str, message: &str, outcome: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            outcome: outcome.into(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Reply {
    schema: String,
    id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ToolError>,
    operation_id: String,
}

impl Reply {
    pub fn new(request: &Request, result: Result<Value, ToolError>) -> Self {
        let (data, error) = match result {
            Ok(value) => (Some(value), None),
            Err(error) => (None, Some(error)),
        };
        Self {
            schema: "cosy.tool.reply/1".into(),
            id: request.id.clone(),
            ok: error.is_none(),
            data,
            error,
            operation_id: request.id.clone(),
        }
    }
}

#[derive(Deserialize, Serialize)]
struct Receipt {
    request: Request,
    reply: Reply,
}

pub struct RequestLog {
    root: PathBuf,
    _lease: File,
    #[cfg(windows)]
    access: crate::private_directory::permissions::Access,
}

fn reject_link(path: &Path) -> io::Result<()> {
    let metadata = fs::symlink_metadata(path)?;
    let link = metadata.file_type().is_symlink();
    #[cfg(windows)]
    let link = {
        use std::os::windows::fs::MetadataExt;
        link || metadata.file_attributes() & 0x400 != 0
    };
    if link {
        return Err(io::Error::other(
            "Request data may not use links or reparse points",
        ));
    }
    Ok(())
}

impl RequestLog {
    pub fn open(root: PathBuf) -> io::Result<Self> {
        #[cfg(windows)]
        let access = crate::private_directory::permissions::Access::current()?;
        #[cfg(windows)]
        match access.create_dir(&root) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                reject_link(&root)?;
                access.ensure_directory(&root)?;
            }
            Err(error) => return Err(error),
        }
        #[cfg(not(windows))]
        fs::create_dir_all(&root)?;
        let lock = root.join("engine.lock");
        #[cfg(windows)]
        let created = access.create_file(&lock);
        #[cfg(not(windows))]
        let created = OpenOptions::new().write(true).create_new(true).open(&lock);
        let lease = match created {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                reject_link(&lock)?;
                #[cfg(windows)]
                access.verify(&lock)?;
                OpenOptions::new().write(true).open(lock)?
            }
            Err(error) => return Err(error),
        };
        lease
            .try_lock()
            .map_err(|error| io::Error::other(error.to_string()))?;
        Ok(Self {
            root,
            _lease: lease,
            #[cfg(windows)]
            access,
        })
    }

    fn path(&self, id: &str) -> PathBuf {
        self.root
            .join(format!("op-{:x}.json", Sha256::digest(id.as_bytes())))
    }

    fn read(&self, id: &str) -> io::Result<Option<Receipt>> {
        let path = self.path(id);
        match reject_link(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        }
        #[cfg(windows)]
        self.access.verify(&path)?;
        let mut bytes = Vec::new();
        File::open(path)?
            .take((MAX_RECEIPT_BYTES + 1) as u64)
            .read_to_end(&mut bytes)?;
        if bytes.len() > MAX_RECEIPT_BYTES {
            return Err(io::Error::other("Request receipt is too large"));
        }
        let mut receipt: Receipt = serde_json::from_slice(&bytes)?;
        if let Some(data) = receipt.reply.data.as_mut().and_then(Value::as_object_mut) {
            data.remove("recording");
            if receipt.request.operation == "describe" {
                if let Some(operations) = data.get_mut("operations").and_then(Value::as_array_mut) {
                    operations.retain(|operation| {
                        !operation
                            .as_str()
                            .is_some_and(|name| name.starts_with("recording."))
                    });
                }
            }
        }
        Ok(Some(receipt))
    }

    fn write(&self, request: &Request, reply: &Reply) -> io::Result<()> {
        let candidate = self.root.join(format!("{}.pending", uuid::Uuid::new_v4()));
        #[cfg(windows)]
        let mut file = self.access.create_file(&candidate)?;
        #[cfg(not(windows))]
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)?;
        let result = (move || {
            let bytes = serde_json::to_vec(&Receipt {
                request: request.clone(),
                reply: reply.clone(),
            })?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            Ok::<_, io::Error>(())
        })()
        .and_then(|()| fs::rename(&candidate, self.path(&request.id)));
        if result.is_err() {
            let _ = fs::remove_file(candidate);
        }
        result
    }

    pub fn operation(&self, id: &str) -> io::Result<Option<Reply>> {
        Ok(self
            .read(id)?
            .filter(|receipt| !receipt.request.operation.starts_with("recording."))
            .map(|receipt| receipt.reply))
    }

    pub fn execute(
        &self,
        request: &Request,
        apply: impl FnOnce() -> Result<Value, ToolError>,
    ) -> Reply {
        let valid_label = |label: &str| {
            !label.is_empty() && label.len() <= 128 && !label.chars().any(char::is_control)
        };
        let deny =
            |code, message| Reply::new(request, Err(ToolError::new(code, message, "denied")));
        let unavailable = |error: io::Error| {
            Reply::new(
                request,
                Err(ToolError::new(
                    "tool_state_unavailable",
                    &error.to_string(),
                    "failed",
                )),
            )
        };
        if request.operation.starts_with("recording.") {
            return deny("unsupported", "Unknown tool operation");
        }
        if request.schema != REQUEST_SCHEMA
            || !valid_label(&request.id)
            || !valid_label(&request.operation)
            || !request.params.is_object()
            || serde_json::to_vec(request).map_or(true, |bytes| bytes.len() > MAX_REQUEST_BYTES)
        {
            return deny(
                "invalid_request",
                "Invalid tool protocol, identifier, operation, or parameters",
            );
        }
        match self.read(&request.id) {
            Ok(Some(receipt)) if receipt.request == *request => return receipt.reply,
            Ok(Some(_)) => {
                return deny(
                    "request_id_conflict",
                    "This request ID was already used with different input",
                )
            }
            Err(error) => return unavailable(error),
            Ok(None) => {}
        }
        let pending = Reply::new(
            request,
            Err(ToolError::new(
                "outcome_unknown",
                "Operation accepted without a confirmed outcome",
                "unknown",
            )),
        );
        if let Err(error) = self.write(request, &pending) {
            return unavailable(error);
        }
        let result = Reply::new(request, apply());
        if self.write(request, &result).is_err() {
            return pending;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_receipts_keep_timer_results_and_hide_retired_data() {
        let root = PathBuf::from(std::env::var_os("POMODORO_TOOL_TEST_ROOT").unwrap());
        let directory = root.join(format!("legacy-receipts-{}", uuid::Uuid::new_v4()));
        let log = RequestLog::open(directory.clone()).unwrap();
        let request = |id: &str, operation: &str| Request {
            schema: REQUEST_SCHEMA.into(),
            id: id.into(),
            operation: operation.into(),
            params: json!({}),
            expected_revision: None,
        };
        let old = request("one", "describe");
        log.write(
            &old,
            &Reply::new(
                &old,
                Ok(json!({"operations":["start","recording.status"],"recording":{"enabled":true}})),
            ),
        )
        .unwrap();
        let retired = request("two", "recording.status");
        log.write(&retired, &Reply::new(&retired, Ok(json!({"enabled":true}))))
            .unwrap();
        drop(log);

        let log = RequestLog::open(directory).unwrap();
        let cached = log.execute(&old, || panic!("A stored request must never run twice"));
        assert_eq!(cached.data.unwrap(), json!({"operations":["start"]}));
        assert!(log.operation("two").unwrap().is_none());
        let conflict = log.execute(&request("two", "start"), || {
            panic!("An existing ID cannot be reused")
        });
        assert_eq!(conflict.error.unwrap().code, "request_id_conflict");
    }
}
