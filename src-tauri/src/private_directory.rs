use std::path::{Path, PathBuf};

/// Only the app's default state root is eligible for recovery. Keep an empty
/// legacy Administrators-owned directory as a backup; never adopt its contents.
pub fn recover_empty_legacy_root(
    path: &Path,
    simulate_legacy_owner: bool,
) -> Result<Option<PathBuf>, String> {
    #[cfg(windows)]
    {
        use std::fs::{self, OpenOptions};
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Authorization::{
            ConvertSidToStringSidW, GetSecurityInfo, SE_FILE_OBJECT,
        };
        use windows_sys::Win32::Security::{
            OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
        };
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
            FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        if !path.try_exists().map_err(|e| e.to_string())? {
            return Ok(None);
        }
        let directory = OpenOptions::new()
            .access_mode(0x0002_0080) // READ_CONTROL | FILE_READ_ATTRIBUTES
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|e| e.to_string())?;
        let metadata = directory.metadata().map_err(|e| e.to_string())?;
        use std::os::windows::fs::MetadataExt;
        if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("旧版记录目录不是普通目录，未作更改。".into());
        }
        let owner = unsafe {
            let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
            let mut sid: PSID = std::ptr::null_mut();
            let result = GetSecurityInfo(
                directory.as_raw_handle().cast(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut sid,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &mut descriptor,
            );
            if result != 0 {
                return Err(format!("无法核对旧版目录所有者（{result}）。"));
            }
            let mut text = std::ptr::null_mut();
            if sid.is_null() || ConvertSidToStringSidW(sid, &mut text) == 0 {
                LocalFree(descriptor);
                return Err("无法读取旧版目录所有者。".into());
            }
            let mut length = 0;
            while *text.add(length) != 0 {
                length += 1;
            }
            let value = String::from_utf16_lossy(std::slice::from_raw_parts(text, length));
            LocalFree(text.cast());
            LocalFree(descriptor);
            value
        };
        // The simulation flag is only supplied by an explicitly isolated QA launch.
        if owner != "S-1-5-32-544" && !simulate_legacy_owner {
            return Ok(None);
        }
        if fs::read_dir(path)
            .map_err(|e| e.to_string())?
            .next()
            .is_some()
        {
            return Ok(None);
        }
        let mut leaf = path.file_name().ok_or("记录目录缺少名称。")?.to_os_string();
        leaf.push(format!(".legacy-empty-{}", uuid::Uuid::new_v4()));
        let backup = path.parent().ok_or("记录目录缺少父目录。")?.join(leaf);
        drop(directory);
        // Preserve the original object and its security descriptor.
        fs::rename(path, &backup).map_err(|e| e.to_string())?;
        return Ok(Some(backup));
    }
    #[cfg(not(windows))]
    {
        let _ = (path, simulate_legacy_owner);
        Ok(None)
    }
}

#[cfg(windows)]
pub mod permissions {
    use std::{
        ffi::c_void,
        fs::{File, OpenOptions},
        io,
        os::windows::{
            ffi::OsStrExt,
            fs::OpenOptionsExt,
            io::{AsRawHandle, FromRawHandle},
        },
        path::Path,
        ptr,
    };
    use windows_sys::Win32::{
        Foundation::{LocalFree, GENERIC_WRITE, INVALID_HANDLE_VALUE},
        Security::{
            Authorization::{
                ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
                GetNamedSecurityInfoW, GetSecurityInfo, SetSecurityInfo, SE_FILE_OBJECT,
            },
            GetAce, GetSecurityDescriptorControl, GetSecurityDescriptorDacl, ACCESS_ALLOWED_ACE,
            ACE_HEADER, ACL, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
            PROTECTED_DACL_SECURITY_INFORMATION, SECURITY_ATTRIBUTES, SE_DACL_PROTECTED,
        },
        Storage::FileSystem::{
            CreateDirectoryW, CreateFileW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, READ_CONTROL, WRITE_DAC,
        },
    };

    struct LocalAllocation(*mut c_void);

    impl Drop for LocalAllocation {
        fn drop(&mut self) {
            unsafe { LocalFree(self.0) };
        }
    }

    fn path_wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    pub struct Access(String);

    impl Access {
        pub fn current() -> io::Result<Self> {
            crate::tool_ipc::current_account_sid()
                .map(Self)
                .map_err(io::Error::other)
        }

        fn create<T>(
            &self,
            directory: bool,
            create: impl FnOnce(&SECURITY_ATTRIBUTES) -> io::Result<T>,
        ) -> io::Result<T> {
            let flags = if directory { "OICI" } else { "" };
            let sddl: Vec<u16> = format!(
                "O:{}D:P(A;{flags};FA;;;{})(A;{flags};FA;;;SY)(A;{flags};FA;;;BA)",
                self.0, self.0
            )
            .encode_utf16()
            .chain(Some(0))
            .collect();
            let mut descriptor = ptr::null_mut();
            if unsafe {
                ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.as_ptr(),
                    1,
                    &mut descriptor,
                    ptr::null_mut(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            let descriptor = LocalAllocation(descriptor);
            create(&SECURITY_ATTRIBUTES {
                nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
                lpSecurityDescriptor: descriptor.0,
                bInheritHandle: 0,
            })
        }

        pub fn create_dir(&self, path: &Path) -> io::Result<()> {
            self.create(true, |attributes| {
                let result = unsafe { CreateDirectoryW(path_wide(path).as_ptr(), attributes) };
                if result == 0 {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(())
                }
            })
        }

        pub fn ensure_directory(&self, path: &Path) -> io::Result<()> {
            match self.verify(path) {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() == io::ErrorKind::PermissionDenied => {}
                Err(error) => return Err(error),
            }
            let directory = OpenOptions::new()
                .access_mode(READ_CONTROL | WRITE_DAC)
                .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
                .open(path)?;
            use std::os::windows::fs::MetadataExt;
            let info = directory.metadata()?;
            if !info.is_dir() || info.file_attributes() & 0x400 != 0 {
                return Err(io::Error::other(
                    "Timer request data must use a real directory",
                ));
            }
            let mut owner = ptr::null_mut();
            let mut descriptor = ptr::null_mut();
            let status = unsafe {
                GetSecurityInfo(
                    directory.as_raw_handle(),
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION,
                    &mut owner,
                    ptr::null_mut(),
                    ptr::null_mut(),
                    ptr::null_mut(),
                    &mut descriptor,
                )
            };
            if status != 0 {
                return Err(io::Error::from_raw_os_error(status as i32));
            }
            let _descriptor = LocalAllocation(descriptor);
            if owner.is_null() || sid_string(owner)? != self.0 {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Timer request directory must belong to the current user",
                ));
            }
            self.create(true, |attributes| {
                let mut present = 0;
                let mut defaulted = 0;
                let mut acl = ptr::null_mut();
                if unsafe {
                    GetSecurityDescriptorDacl(
                        attributes.lpSecurityDescriptor,
                        &mut present,
                        &mut acl,
                        &mut defaulted,
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                if present == 0 || acl.is_null() {
                    return Err(io::Error::other("Private ACL could not be created"));
                }
                let status = unsafe {
                    SetSecurityInfo(
                        directory.as_raw_handle(),
                        SE_FILE_OBJECT,
                        DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                        ptr::null_mut(),
                        ptr::null_mut(),
                        acl,
                        ptr::null(),
                    )
                };
                if status == 0 {
                    Ok(())
                } else {
                    Err(io::Error::from_raw_os_error(status as i32))
                }
            })?;
            self.verify(path)
        }

        pub fn create_file(&self, path: &Path) -> io::Result<File> {
            self.create(false, |attributes| {
                let handle = unsafe {
                    CreateFileW(
                        path_wide(path).as_ptr(),
                        GENERIC_WRITE,
                        0,
                        attributes,
                        CREATE_NEW,
                        FILE_ATTRIBUTE_NORMAL,
                        ptr::null_mut(),
                    )
                };
                if handle == INVALID_HANDLE_VALUE {
                    Err(io::Error::last_os_error())
                } else {
                    Ok(unsafe { File::from_raw_handle(handle) })
                }
            })
        }

        pub fn verify(&self, path: &Path) -> io::Result<()> {
            let mut descriptor = ptr::null_mut();
            let mut owner = ptr::null_mut();
            let mut acl: *mut ACL = ptr::null_mut();
            let status = unsafe {
                GetNamedSecurityInfoW(
                    path_wide(path).as_ptr(),
                    SE_FILE_OBJECT,
                    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                    &mut owner,
                    ptr::null_mut(),
                    &mut acl,
                    ptr::null_mut(),
                    &mut descriptor,
                )
            };
            if status != 0 {
                return Err(io::Error::from_raw_os_error(status as i32));
            }
            let descriptor = LocalAllocation(descriptor);
            let mut control = 0;
            let mut revision = 0;
            if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) }
                == 0
            {
                return Err(io::Error::last_os_error());
            }
            let rejected = || {
                io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "Timer request data requires a private owner and ACL",
                )
            };
            if acl.is_null()
                || owner.is_null()
                || control & SE_DACL_PROTECTED == 0
                || sid_string(owner)? != self.0
            {
                return Err(rejected());
            }
            for index in 0..u32::from(unsafe { (*acl).AceCount }) {
                let mut ace = ptr::null_mut();
                if unsafe { GetAce(acl, index, &mut ace) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                if unsafe { (*ace.cast::<ACE_HEADER>()).AceType } != 0 {
                    return Err(rejected());
                }
                let sid = unsafe {
                    ptr::addr_of_mut!((*ace.cast::<ACCESS_ALLOWED_ACE>()).SidStart).cast()
                };
                let account = sid_string(sid)?;
                if account != self.0 && !matches!(account.as_str(), "S-1-5-18" | "S-1-5-32-544") {
                    return Err(rejected());
                }
            }
            Ok(())
        }
    }

    fn sid_string(sid: *mut c_void) -> io::Result<String> {
        let mut raw = ptr::null_mut();
        if unsafe { ConvertSidToStringSidW(sid, &mut raw) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let _allocation = LocalAllocation(raw.cast());
        let length = (0..)
            .find(|offset| unsafe { *raw.add(*offset) } == 0)
            .unwrap();
        Ok(String::from_utf16_lossy(unsafe {
            std::slice::from_raw_parts(raw, length)
        }))
    }
}
