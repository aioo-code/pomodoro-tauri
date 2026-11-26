//! Installer-only helper: no webview, no timer/profile initialization, no force kill.
#[cfg(windows)]
mod platform {
    use serde::Serialize;
    use serde_json::json;
    use std::{mem, path::Path, ptr};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, FILETIME, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            RestartManager::{
                RmEndSession, RmRegisterResources, RmShutdown, RmStartSession, RM_UNIQUE_PROCESS,
            },
            Threading::{
                GetCurrentProcessId, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW,
                WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
            },
        },
    };
    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    struct Session(u32);
    impl Drop for Session {
        fn drop(&mut self) {
            unsafe {
                RmEndSession(self.0);
            }
        }
    }
    #[derive(Serialize)]
    struct Instance {
        pid: u32,
        path: String,
    }
    struct Candidate {
        instance: Instance,
        handle: Handle,
        identity: RM_UNIQUE_PROCESS,
    }

    fn key(path: &str) -> String {
        path.trim_start_matches(r"\\?\")
            .replace('/', "\\")
            .to_lowercase()
    }
    fn discover(target: &Path, qa: bool) -> Result<Vec<Candidate>, String> {
        if !target.is_absolute() {
            return Err("安装目标必须是绝对路径。".into());
        }
        let target = key(&target.to_string_lossy());
        let request = json!({"schema":crate::request_log::REQUEST_SCHEMA,"id":uuid::Uuid::new_v4().to_string(),"operation":"describe","params":{}});
        let peer = crate::tool_ipc::pipe_name(qa)
            .and_then(|name| crate::tool_ipc::call_with_pid(&name, &request))
            .ok()
            .filter(|(_, _, reply)| {
                reply["ok"] == true
                    && reply["data"]["tool_id"] == "pomodoro"
                    && reply["data"]["qa"] == qa
            })
            .map(|(pid, start, _)| (pid, start));
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
        if raw == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let snapshot = Handle(raw);
        let mut entry: PROCESSENTRY32W = unsafe { mem::zeroed() };
        entry.dwSize = mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut running = unsafe { Process32FirstW(snapshot.0, &mut entry) };
        let mut candidates = Vec::new();
        while running != 0 {
            let pid = entry.th32ProcessID;
            let name = String::from_utf16_lossy(
                &entry.szExeFile[..entry
                    .szExeFile
                    .iter()
                    .position(|v| *v == 0)
                    .unwrap_or(entry.szExeFile.len())],
            );
            if pid != unsafe { GetCurrentProcessId() }
                && (peer.is_some_and(|(id, _)| id == pid)
                    || name.eq_ignore_ascii_case("pomodoro-connected.exe"))
            {
                let raw = unsafe {
                    OpenProcess(
                        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                        0,
                        pid,
                    )
                };
                if !raw.is_null() {
                    let process = Handle(raw);
                    if crate::tool_ipc::same_account(process.0).unwrap_or(false) {
                        let mut path = vec![0u16; 32768];
                        let mut len = path.len() as u32;
                        if unsafe {
                            QueryFullProcessImageNameW(process.0, 0, path.as_mut_ptr(), &mut len)
                        } != 0
                        {
                            let path = String::from_utf16_lossy(&path[..len as usize]);
                            if peer.is_some_and(|(id, _)| id == pid) || key(&path) == target {
                                let mut created: FILETIME = unsafe { mem::zeroed() };
                                let mut exited = created;
                                let mut kernel = created;
                                let mut user = created;
                                if unsafe {
                                    GetProcessTimes(
                                        process.0,
                                        &mut created,
                                        &mut exited,
                                        &mut kernel,
                                        &mut user,
                                    )
                                } == 0
                                {
                                    return Err(std::io::Error::last_os_error().to_string());
                                }
                                let start = ((created.dwHighDateTime as u64) << 32)
                                    | created.dwLowDateTime as u64;
                                if key(&path) != target && peer != Some((pid, start)) {
                                    running = unsafe { Process32NextW(snapshot.0, &mut entry) };
                                    continue;
                                }
                                candidates.push(Candidate {
                                    instance: Instance { pid, path },
                                    handle: process,
                                    identity: RM_UNIQUE_PROCESS {
                                        dwProcessId: pid,
                                        ProcessStartTime: created,
                                    },
                                });
                            }
                        }
                    }
                }
            }
            running = unsafe { Process32NextW(snapshot.0, &mut entry) };
        }
        Ok(candidates)
    }
    pub fn run(target: &Path, qa: bool, check: bool) -> Result<(serde_json::Value, i32), String> {
        let candidates = discover(target, qa)?;
        let instances: Vec<_> = candidates.iter().map(|c| &c.instance).collect();
        if check || candidates.is_empty() {
            return Ok((
                json!({"ok":true,"check":check,"instances":instances,"closed":0}),
                if check && !candidates.is_empty() {
                    10
                } else {
                    0
                },
            ));
        }
        let mut session = 0;
        let mut secret = [0u16; 33];
        let status = unsafe { RmStartSession(&mut session, 0, secret.as_mut_ptr()) };
        if status != 0 {
            return Err(format!("无法准备关闭应用：{status}"));
        }
        let session = Session(session);
        let processes: Vec<_> = candidates.iter().map(|c| c.identity).collect();
        let status = unsafe {
            RmRegisterResources(
                session.0,
                0,
                ptr::null(),
                processes.len() as u32,
                processes.as_ptr(),
                0,
                ptr::null(),
            )
        };
        if status != 0 {
            return Err(format!("无法登记应用实例：{status}"));
        }
        // Flags=0 requests a normal Windows session end; never RmForceShutdown.
        let status = unsafe { RmShutdown(session.0, 0, None) };
        let stopped = candidates
            .iter()
            .all(|c| unsafe { WaitForSingleObject(c.handle.0, 10000) } == WAIT_OBJECT_0);
        if !stopped {
            return Err(format!("应用未能正常退出（{status}），请手动关闭后重试。"));
        }
        Ok((
            json!({"ok":true,"check":false,"closed":instances.len(),"instances":instances,"shutdown":"graceful_restart_manager"}),
            0,
        ))
    }
}

pub fn dispatch(args: &[String]) -> Option<i32> {
    let index = args.iter().position(|arg| arg == "--prepare-update")?;
    #[cfg(windows)]
    let result = args
        .get(index + 1)
        .ok_or_else(|| "缺少安装目标路径。".to_owned())
        .and_then(|target| {
            platform::run(
                std::path::Path::new(target),
                args.iter().any(|a| a == "--tool-qa"),
                args.iter().any(|a| a == "--check"),
            )
        });
    #[cfg(not(windows))]
    let result: Result<(serde_json::Value, i32), String> = Err("仅支持 Windows。".into());
    Some(match result {
        Ok((report, code)) => {
            println!("{report}");
            code
        }
        Err(error) => {
            println!("{}", serde_json::json!({"ok":false,"error":error}));
            2
        }
    })
}
