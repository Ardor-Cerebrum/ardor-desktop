use std::{
    backtrace::Backtrace,
    ffi::c_void,
    fmt::{self, Write as _},
    fs::{self, File, OpenOptions},
    io::Write as _,
    os::windows::io::AsRawHandle,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    time::{SystemTime, UNIX_EPOCH},
};

use windows::Win32::{
    Foundation::{
        EXCEPTION_ACCESS_VIOLATION, EXCEPTION_BREAKPOINT, EXCEPTION_ILLEGAL_INSTRUCTION,
        EXCEPTION_STACK_OVERFLOW, HANDLE, STATUS_FAIL_FAST_EXCEPTION, STATUS_HEAP_CORRUPTION,
        STATUS_STACK_BUFFER_OVERRUN,
    },
    Storage::FileSystem::WriteFile,
    System::{
        Diagnostics::Debug::{
            AddVectoredExceptionHandler, MiniDumpWithFullMemoryInfo, MiniDumpWithHandleData,
            MiniDumpWithIndirectlyReferencedMemory, MiniDumpWithThreadInfo,
            MiniDumpWithUnloadedModules, MiniDumpWriteDump, SetUnhandledExceptionFilter,
            EXCEPTION_CONTINUE_SEARCH, EXCEPTION_POINTERS, MINIDUMP_EXCEPTION_INFORMATION,
            MINIDUMP_TYPE,
        },
        Threading::{GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId},
    },
};

static CRASH_RECORDED: AtomicBool = AtomicBool::new(false);
static CRASH_LOG: OnceLock<File> = OnceLock::new();
static DUMP_FILE: OnceLock<File> = OnceLock::new();

struct FixedBuffer {
    bytes: [u8; 512],
    len: usize,
}

impl FixedBuffer {
    const fn new() -> Self {
        Self {
            bytes: [0; 512],
            len: 0,
        }
    }

    fn as_bytes(&self) -> &[u8] {
        &self.bytes[..self.len]
    }
}

impl fmt::Write for FixedBuffer {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        let remaining = self.bytes.len().saturating_sub(self.len);
        let length = value.len().min(remaining);
        self.bytes[self.len..self.len + length].copy_from_slice(&value.as_bytes()[..length]);
        self.len += length;
        Ok(())
    }
}

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn diagnostics_directory() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("ardor-solutions-desktop")
        .join("diagnostics")
}

fn write_session_start(path: &PathBuf, run_id: &str, dump_path: &PathBuf, cef_log: &PathBuf) {
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let record = serde_json::json!({
        "timestamp_ms": timestamp_ms(),
        "pid": std::process::id(),
        "thread": format!("{:?}", std::thread::current().id()),
        "event": "diagnostics.session.start",
        "details": {
            "run_id": run_id,
            "version": env!("CARGO_PKG_VERSION"),
            "dump_file": dump_path,
            "cef_log_file": cef_log,
        },
    });
    if serde_json::to_writer(&mut file, &record).is_ok() {
        let _ = file.write_all(b"\n");
        let _ = file.flush();
        let _ = file.sync_data();
    }
}

fn append_panic(path: &PathBuf, info: &std::panic::PanicHookInfo<'_>) {
    let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) else {
        return;
    };
    let location = info
        .location()
        .map(|location| {
            format!(
                "{}:{}:{}",
                location.file(),
                location.line(),
                location.column()
            )
        })
        .unwrap_or_else(|| "unknown".to_string());
    let payload = info
        .payload()
        .downcast_ref::<&str>()
        .copied()
        .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str))
        .unwrap_or("non-string panic payload");
    let _ = writeln!(
        file,
        "timestamp_ms={} pid={} thread={:?} panic={payload:?} location={location}\n{}",
        timestamp_ms(),
        std::process::id(),
        std::thread::current().id(),
        Backtrace::force_capture(),
    );
    let _ = file.flush();
    let _ = file.sync_data();
}

fn is_crash_exception(code: i32) -> bool {
    code == EXCEPTION_ACCESS_VIOLATION.0
        || code == EXCEPTION_BREAKPOINT.0
        || code == EXCEPTION_ILLEGAL_INSTRUCTION.0
        || code == EXCEPTION_STACK_OVERFLOW.0
        || code == STATUS_FAIL_FAST_EXCEPTION.0
        || code == STATUS_HEAP_CORRUPTION.0
        || code == STATUS_STACK_BUFFER_OVERRUN.0
}

unsafe fn write_crash_record(exception_info: *mut EXCEPTION_POINTERS) {
    if exception_info.is_null() {
        return;
    }
    let exception_record = unsafe { (*exception_info).ExceptionRecord };
    if exception_record.is_null() {
        return;
    }
    let code = unsafe { (*exception_record).ExceptionCode.0 };
    if !is_crash_exception(code) || CRASH_RECORDED.swap(true, Ordering::AcqRel) {
        return;
    }

    let address = unsafe { (*exception_record).ExceptionAddress } as usize;
    let mut line = FixedBuffer::new();
    let _ = writeln!(
        line,
        "timestamp_ms={} pid={} thread={} exception=0x{:08x} address=0x{:016x}",
        timestamp_ms(),
        unsafe { GetCurrentProcessId() },
        unsafe { GetCurrentThreadId() },
        code as u32,
        address,
    );
    if let Some(file) = CRASH_LOG.get() {
        let handle = HANDLE(file.as_raw_handle().cast::<c_void>());
        let mut written = 0;
        let _ = unsafe { WriteFile(handle, Some(line.as_bytes()), Some(&mut written), None) };
    }

    let Some(file) = DUMP_FILE.get() else {
        return;
    };
    let dump_type = MINIDUMP_TYPE(
        MiniDumpWithFullMemoryInfo.0
            | MiniDumpWithHandleData.0
            | MiniDumpWithIndirectlyReferencedMemory.0
            | MiniDumpWithThreadInfo.0
            | MiniDumpWithUnloadedModules.0,
    );
    let exception = MINIDUMP_EXCEPTION_INFORMATION {
        ThreadId: unsafe { GetCurrentThreadId() },
        ExceptionPointers: exception_info,
        ClientPointers: false.into(),
    };
    let dump_handle = HANDLE(file.as_raw_handle().cast::<c_void>());
    let _ = unsafe {
        MiniDumpWriteDump(
            GetCurrentProcess(),
            GetCurrentProcessId(),
            dump_handle,
            dump_type,
            Some(&exception),
            None,
            None,
        )
    };
}

unsafe extern "system" fn vectored_exception_handler(
    exception_info: *mut EXCEPTION_POINTERS,
) -> i32 {
    unsafe { write_crash_record(exception_info) };
    EXCEPTION_CONTINUE_SEARCH
}

unsafe extern "system" fn unhandled_exception_filter(
    exception_info: *const EXCEPTION_POINTERS,
) -> i32 {
    unsafe { write_crash_record(exception_info.cast_mut()) };
    EXCEPTION_CONTINUE_SEARCH
}

pub fn install() {
    let directory = diagnostics_directory();
    if fs::create_dir_all(&directory).is_err() {
        return;
    }

    let run_id = format!("{}-{}", timestamp_ms(), std::process::id());
    let event_path = directory.join(format!("devtools-{run_id}.log"));
    let crash_log_path = directory.join(format!("crash-{run_id}.txt"));
    let dump_path = directory.join(format!("crash-{run_id}.dmp"));
    let cef_log_path = directory.join(format!("cef-{run_id}.log"));
    let panic_path = directory.join(format!("panic-{run_id}.log"));

    std::env::set_var("ARDOR_CEF_DEVTOOLS_TRACE_FILE", &event_path);
    if std::env::var_os("ARDOR_CEF_LOG_FILE").is_none() {
        std::env::set_var("ARDOR_CEF_LOG_FILE", &cef_log_path);
    }

    write_session_start(&event_path, &run_id, &dump_path, &cef_log_path);

    if let Ok(file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&crash_log_path)
    {
        let _ = CRASH_LOG.set(file);
    }
    if let Ok(file) = File::create(&dump_path) {
        let _ = DUMP_FILE.set(file);
    }

    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        append_panic(&panic_path, info);
        previous_hook(info);
    }));

    unsafe {
        AddVectoredExceptionHandler(1, Some(vectored_exception_handler));
        SetUnhandledExceptionFilter(Some(unhandled_exception_filter));
    }
}

#[cfg(test)]
mod tests {
    use super::is_crash_exception;
    use windows::Win32::Foundation::{EXCEPTION_ACCESS_VIOLATION, STATUS_FAIL_FAST_EXCEPTION};

    #[test]
    fn captures_fatal_windows_exceptions_only() {
        assert!(is_crash_exception(EXCEPTION_ACCESS_VIOLATION.0));
        assert!(is_crash_exception(STATUS_FAIL_FAST_EXCEPTION.0));
        assert!(!is_crash_exception(0));
    }
}
