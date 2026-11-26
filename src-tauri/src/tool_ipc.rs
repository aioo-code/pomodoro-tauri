//! Account-local, bounded one-request named-pipe transport. No UI or process launch.
use serde_json::Value;

#[cfg(windows)]
mod platform {
    use super::*;
    use std::{
        mem, ptr,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, LocalFree, ERROR_IO_PENDING, ERROR_PIPE_CONNECTED, FILETIME,
            GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE, WAIT_OBJECT_0,
        },
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
            },
            GetTokenInformation, TokenUser, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
        },
        Storage::FileSystem::{
            CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED,
            OPEN_EXISTING, PIPE_ACCESS_DUPLEX, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
        },
        System::{
            Pipes::{
                ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe,
                GetNamedPipeClientProcessId, GetNamedPipeServerProcessId, WaitNamedPipeW,
                PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE, PIPE_WAIT,
            },
            Threading::{
                CreateEventW, GetCurrentProcess, GetProcessTimes, OpenProcess, OpenProcessToken,
                WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            },
            IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        },
    };

    const MAX_FRAME: usize = 1024 * 1024;
    const IO_TIMEOUT: Duration = Duration::from_secs(5);

    struct Handle(HANDLE);
    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    fn error(context: &str) -> String {
        format!("{context}: {}", std::io::Error::last_os_error())
    }
    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    fn process_sid(process: HANDLE) -> Result<String, String> {
        unsafe {
            let mut raw = ptr::null_mut();
            if OpenProcessToken(process, TOKEN_QUERY, &mut raw) == 0 {
                return Err(error("peer_token"));
            }
            let token = Handle(raw);
            let mut size = 0;
            GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut size);
            if size == 0 || size > 64 * 1024 {
                return Err("peer_token_invalid".into());
            }
            // TOKEN_USER contains pointers and requires native alignment.
            let mut buffer = vec![0usize; (size as usize).div_ceil(mem::size_of::<usize>())];
            if GetTokenInformation(
                token.0,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                size,
                &mut size,
            ) == 0
            {
                return Err(error("peer_token"));
            }
            let user = &*(buffer.as_ptr().cast::<TOKEN_USER>());
            let mut string = ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut string) == 0 {
                return Err(error("peer_sid"));
            }
            let mut length = 0;
            while *string.add(length) != 0 {
                length += 1;
            }
            let result = String::from_utf16_lossy(std::slice::from_raw_parts(string, length));
            LocalFree(string.cast());
            Ok(result)
        }
    }

    pub fn current_account_sid() -> Result<String, String> {
        process_sid(unsafe { GetCurrentProcess() })
    }
    fn current_sid() -> Result<String, String> {
        unsafe { process_sid(GetCurrentProcess()) }
    }
    pub fn same_account(process: HANDLE) -> Result<bool, String> {
        Ok(process_sid(process)? == current_sid()?)
    }

    fn verify_peer(pipe: HANDLE, server: bool) -> Result<(), String> {
        unsafe {
            let mut pid = 0;
            let ok = if server {
                GetNamedPipeServerProcessId(pipe, &mut pid)
            } else {
                GetNamedPipeClientProcessId(pipe, &mut pid)
            };
            if ok == 0 || pid == 0 {
                return Err(error("peer_unverified"));
            }
            let raw = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if raw.is_null() {
                return Err(error("peer_unverified"));
            }
            let peer = Handle(raw);
            if process_sid(peer.0)? != current_sid()? {
                return Err("peer_account_denied".into());
            }
            Ok(())
        }
    }

    pub fn pipe_name(qa: bool) -> Result<String, String> {
        Ok(format!(
            r"\\.\pipe\cosy.pomodoro.{}.{}",
            current_sid()?,
            if qa { "qa" } else { "daily" }
        ))
    }
    fn create_pipe(name: &str) -> Result<Handle, String> {
        let sid = current_sid()?;
        let sddl = wide(&format!("O:{sid}D:P(A;;GA;;;{sid})"));
        unsafe {
            let mut descriptor = ptr::null_mut();
            if ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                ptr::null_mut(),
            ) == 0
            {
                return Err(error("pipe_security"));
            }
            let attributes = SECURITY_ATTRIBUTES {
                nLength: mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor,
                bInheritHandle: 0,
            };
            let raw = CreateNamedPipeW(
                wide(name).as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                65536,
                65536,
                1000,
                &attributes,
            );
            LocalFree(descriptor);
            if raw == INVALID_HANDLE_VALUE {
                Err(error("pipe_bind"))
            } else {
                Ok(Handle(raw))
            }
        }
    }

    // Every OVERLAPPED and its buffer remains live until completion or cancellation.
    fn overlapped<T>(
        pipe: HANDLE,
        deadline: Instant,
        start: impl FnOnce(*mut OVERLAPPED, *mut u32) -> T,
        succeeded: impl FnOnce(T) -> bool,
        connect: bool,
    ) -> Result<u32, String> {
        unsafe {
            let event = Handle(CreateEventW(ptr::null(), 1, 0, ptr::null()));
            if event.0.is_null() {
                return Err(error("pipe_event"));
            }
            let mut pending: OVERLAPPED = mem::zeroed();
            pending.hEvent = event.0;
            let mut count = 0;
            if succeeded(start(&mut pending, &mut count)) {
                return Ok(count);
            }
            let code = GetLastError();
            if connect && code == ERROR_PIPE_CONNECTED {
                return Ok(0);
            }
            if code != ERROR_IO_PENDING {
                return Err(error("pipe_io"));
            }
            let remaining = deadline
                .saturating_duration_since(Instant::now())
                .as_millis()
                .min(u32::MAX as u128) as u32;
            if WaitForSingleObject(event.0, remaining) != WAIT_OBJECT_0 {
                CancelIoEx(pipe, &pending);
                GetOverlappedResult(pipe, &pending, &mut count, 1);
                return Err("pipe_timeout".into());
            }
            if GetOverlappedResult(pipe, &pending, &mut count, 0) == 0 {
                return Err(error("pipe_io"));
            }
            Ok(count)
        }
    }
    fn connect(pipe: HANDLE) -> Result<(), String> {
        overlapped(
            pipe,
            Instant::now() + Duration::from_secs(30),
            |overlap, _| unsafe { ConnectNamedPipe(pipe, overlap) },
            |ok| ok != 0,
            true,
        )
        .map(|_| ())
    }
    fn read_frame(pipe: HANDLE) -> Result<Value, String> {
        let deadline = Instant::now() + IO_TIMEOUT;
        let mut result = Vec::new();
        loop {
            let mut buffer = [0u8; 4096];
            let count = overlapped(
                pipe,
                deadline,
                |overlap, count| unsafe {
                    ReadFile(
                        pipe,
                        buffer.as_mut_ptr(),
                        buffer.len() as u32,
                        count,
                        overlap,
                    )
                },
                |ok| ok != 0,
                false,
            )? as usize;
            if count == 0 {
                return Err("pipe_closed".into());
            }
            let end = buffer[..count].iter().position(|b| *b == b'\n');
            let bytes = end.unwrap_or(count);
            if result.len() + bytes > MAX_FRAME {
                return Err("frame_too_large".into());
            }
            result.extend_from_slice(&buffer[..bytes]);
            if let Some(end) = end {
                if buffer[end + 1..count]
                    .iter()
                    .any(|b| !b.is_ascii_whitespace())
                {
                    return Err("multiple_frames".into());
                }
                return serde_json::from_slice(&result).map_err(|_| "invalid_json".into());
            }
        }
    }
    fn write_frame(pipe: HANDLE, value: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(value).map_err(|_| "invalid_json")?;
        if bytes.len() > MAX_FRAME {
            return Err("frame_too_large".into());
        }
        bytes.push(b'\n');
        let deadline = Instant::now() + IO_TIMEOUT;
        let mut offset = 0;
        while offset < bytes.len() {
            let count = overlapped(
                pipe,
                deadline,
                |overlap, count| unsafe {
                    WriteFile(
                        pipe,
                        bytes[offset..].as_ptr(),
                        (bytes.len() - offset) as u32,
                        count,
                        overlap,
                    )
                },
                |ok| ok != 0,
                false,
            )? as usize;
            if count == 0 {
                return Err("pipe_closed".into());
            }
            offset += count;
        }
        Ok(())
    }

    pub fn serve(
        name: String,
        handler: impl Fn(Value) -> Value + Send + Sync + 'static,
    ) -> Result<(), String> {
        let first = create_pipe(&name)?;
        let first_raw = first.0 as usize;
        mem::forget(first);
        std::thread::Builder::new()
            .name("tool-pipe".into())
            .spawn(move || {
                let pipe = Handle(first_raw as HANDLE);
                loop {
                    if connect(pipe.0).is_ok() && verify_peer(pipe.0, false).is_ok() {
                        match read_frame(pipe.0) {
                            Ok(request) => {
                                let reply = handler(request);
                                if write_frame(pipe.0, &reply).is_ok() {
                                    // DisconnectNamedPipe discards unread buffered data. Wait for
                                    // a bounded ACK rather than FlushFileBuffers (which can hang).
                                    let _ = read_frame(pipe.0);
                                }
                            }
                            Err(code) => {
                                let _ = write_frame(
                                    pipe.0,
                                    &serde_json::json!({"ok":false,"error":{"code":code}}),
                                );
                            }
                        }
                    }
                    unsafe {
                        DisconnectNamedPipe(pipe.0);
                    }
                    // Reuse the same secured pipe instance: no discoverable name gap.
                    // A later ConnectNamedPipe handles a client arriving before this loop.
                }
            })
            .map_err(|e| {
                unsafe {
                    CloseHandle(first_raw as HANDLE);
                }
                format!("pipe_worker: {e}")
            })?;
        Ok(())
    }

    pub fn call(name: &str, request: &Value) -> Result<Value, String> {
        call_with_pid(name, request).map(|(_, _, reply)| reply)
    }
    pub fn call_with_pid(name: &str, request: &Value) -> Result<(u32, u64, Value), String> {
        let name = wide(name);
        let deadline = Instant::now() + IO_TIMEOUT;
        let raw = loop {
            let handle = unsafe {
                CreateFileW(
                    name.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                    ptr::null_mut(),
                )
            };
            if handle != INVALID_HANDLE_VALUE {
                break handle;
            }
            let code = unsafe { GetLastError() };
            // FILE_NOT_FOUND means no instance; do not start one or activate UI.
            if code != 231 || Instant::now() >= deadline {
                return Err(error("tool_unavailable"));
            }
            unsafe {
                WaitNamedPipeW(name.as_ptr(), 100);
            }
        };
        let pipe = Handle(raw);
        verify_peer(pipe.0, true)?;
        let mut pid = 0;
        if unsafe { GetNamedPipeServerProcessId(pipe.0, &mut pid) } == 0 || pid == 0 {
            return Err(error("peer_unverified"));
        }
        let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if raw.is_null() {
            return Err(error("peer_unverified"));
        }
        let peer = Handle(raw);
        let mut created: FILETIME = unsafe { mem::zeroed() };
        let mut exited = created;
        let mut kernel = created;
        let mut user = created;
        if unsafe { GetProcessTimes(peer.0, &mut created, &mut exited, &mut kernel, &mut user) }
            == 0
        {
            return Err(error("peer_unverified"));
        }
        let start = ((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64;
        write_frame(pipe.0, request)?;
        let reply = read_frame(pipe.0)?;
        // The response has been consumed; this ACK has no business meaning.
        let _ = write_frame(pipe.0, &Value::Null);
        Ok((pid, start, reply))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn local_roundtrip_and_duplicate_bind_rejected() {
            let name = format!("{}.test.{}", pipe_name(true).unwrap(), std::process::id());
            serve(name.clone(), |v| serde_json::json!({"echo":v})).unwrap();
            assert!(serve(name.clone(), |v| v).is_err());
            assert_eq!(
                call(&name, &serde_json::json!({"n":1})).unwrap(),
                serde_json::json!({"echo":{"n":1}})
            );
            assert_eq!(
                call(&name, &serde_json::json!({"n":2})).unwrap(),
                serde_json::json!({"echo":{"n":2}})
            );
        }
        #[test]
        fn missing_server_is_unavailable() {
            let name = format!("{}.absent.{}", pipe_name(true).unwrap(), std::process::id());
            assert!(call(&name, &Value::Null)
                .unwrap_err()
                .contains("tool_unavailable"));
        }
    }
}

#[cfg(windows)]
pub use platform::{call, call_with_pid, current_account_sid, pipe_name, same_account, serve};

#[cfg(not(windows))]
pub fn pipe_name(_: bool) -> Result<String, String> {
    Err("platform_unsupported".into())
}
#[cfg(not(windows))]
pub fn serve(_: String, _: impl Fn(Value) -> Value + Send + Sync + 'static) -> Result<(), String> {
    Err("platform_unsupported".into())
}
#[cfg(not(windows))]
pub fn call(_: &str, _: &Value) -> Result<Value, String> {
    Err("platform_unsupported".into())
}
