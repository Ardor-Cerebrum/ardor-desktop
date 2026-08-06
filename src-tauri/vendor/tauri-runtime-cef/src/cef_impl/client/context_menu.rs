// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use cef::*;
#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSView;
#[cfg(any(windows, target_os = "macos"))]
use std::collections::HashMap;
use std::{
  fs::OpenOptions,
  io::Write,
  path::PathBuf,
  process,
  sync::OnceLock,
  time::{SystemTime, UNIX_EPOCH},
};

#[cfg(all(not(windows), not(target_os = "macos")))]
use crate::runtime::browser_devtools_enabled;
#[cfg(any(windows, target_os = "macos"))]
use crate::runtime::cef_remote_debugging_port;
#[cfg(any(windows, target_os = "macos", test))]
use serde::Deserialize;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicU32;
#[cfg(any(windows, target_os = "macos"))]
use std::sync::{
  Arc, Mutex,
  atomic::{AtomicI32, Ordering},
};
#[cfg(any(windows, target_os = "macos", test))]
use std::{
  io::Read,
  net::{Ipv4Addr, TcpStream},
  time::Duration,
};
#[cfg(any(windows, target_os = "macos", test))]
use url::Url;

#[cfg(any(windows, target_os = "macos", test))]
fn is_trusted_devtools_origin(origin: &str) -> bool {
  let Ok(url) = Url::parse(origin) else {
    return false;
  };
  (url.scheme() == "https" && url.host_str() == Some("chrome-devtools-frontend.appspot.com"))
    || (url.scheme() == "http"
      && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]")))
}

#[cfg(any(windows, target_os = "macos", test))]
fn contains_only_devtools_network_permissions(requested_permissions: u32) -> bool {
  // Bit 25 is the legacy LOCAL_NETWORK_ACCESS value retained by CEF 150 on
  // Windows; cef-rs omits the duplicate enum alias from its generated API.
  let allowed = (1_u32 << 25)
    | cef::sys::cef_permission_request_types_t::CEF_PERMISSION_TYPE_LOCAL_NETWORK as u32
    | cef::sys::cef_permission_request_types_t::CEF_PERMISSION_TYPE_LOOPBACK_NETWORK as u32;
  requested_permissions != 0 && requested_permissions & !allowed == 0
}

#[cfg(any(windows, target_os = "macos"))]
wrap_permission_handler! {
  struct TauriCefDevToolsPermissionHandler;

  impl PermissionHandler {
    fn on_show_permission_prompt(
      &self,
      _browser: Option<&mut Browser>,
      _prompt_id: u64,
      requesting_origin: Option<&CefString>,
      requested_permissions: u32,
      callback: Option<&mut PermissionPromptCallback>,
    ) -> std::os::raw::c_int {
      let origin = requesting_origin
        .map(ToString::to_string)
        .unwrap_or_default();
      let allow = is_trusted_devtools_origin(&origin)
        && contains_only_devtools_network_permissions(requested_permissions);
      trace_devtools(format!(
        "devtools_permission_prompt trusted_origin={} requested_permissions=0x{requested_permissions:x} allow={allow}",
        is_trusted_devtools_origin(&origin)
      ));
      let Some(callback) = callback else {
        return 0;
      };
      callback.cont(if allow {
        PermissionRequestResult::from(
          cef::sys::cef_permission_request_result_t::CEF_PERMISSION_RESULT_ACCEPT,
        )
      } else {
        PermissionRequestResult::DENY
      });
      1
    }
  }
}

wrap_client! {
  struct TauriCefDevToolsClient {
    remote_target_id: Option<String>,
  }

  impl Client {
    fn life_span_handler(&self) -> Option<LifeSpanHandler> {
      #[cfg(any(windows, target_os = "macos"))]
      return self
        .remote_target_id
        .as_ref()
        .map(|target_id| RemoteDevToolsLifeSpanHandler::new(target_id.clone()));

      #[cfg(all(not(windows), not(target_os = "macos")))]
      None
    }

    fn permission_handler(&self) -> Option<PermissionHandler> {
      #[cfg(any(windows, target_os = "macos"))]
      return Some(TauriCefDevToolsPermissionHandler::new());

      #[cfg(all(not(windows), not(target_os = "macos")))]
      None
    }
  }
}

pub(super) fn devtools_client() -> Client {
  TauriCefDevToolsClient::new(None)
}

#[cfg(any(windows, target_os = "macos"))]
fn remote_devtools_client(target_id: String) -> Client {
  TauriCefDevToolsClient::new(Some(target_id))
}

#[cfg(any(windows, target_os = "macos"))]
fn remote_devtools_windows() -> &'static Mutex<HashMap<String, Browser>> {
  static WINDOWS: OnceLock<Mutex<HashMap<String, Browser>>> = OnceLock::new();
  WINDOWS.get_or_init(|| Mutex::new(HashMap::new()))
}

#[cfg(any(windows, target_os = "macos"))]
fn register_remote_devtools_window(target_id: &str, browser: &Browser) {
  let browser_id = browser.identifier();
  remote_devtools_windows()
    .lock()
    .unwrap()
    .insert(target_id.to_string(), browser.clone());
  trace_devtools(format!(
    "remote_devtools.window.registered target_id={target_id} browser_id={browser_id}"
  ));
}

#[cfg(any(windows, target_os = "macos"))]
fn unregister_remote_devtools_window(target_id: &str, browser_id: i32) {
  let mut windows = remote_devtools_windows().lock().unwrap();
  if windows
    .get(target_id)
    .is_some_and(|browser| browser.identifier() == browser_id)
  {
    windows.remove(target_id);
    trace_devtools(format!(
      "remote_devtools.window.unregistered target_id={target_id} browser_id={browser_id}"
    ));
  }
}

#[cfg(target_os = "macos")]
fn focus_remote_devtools_window(browser: &Browser) -> bool {
  let Some(host) = browser.host() else {
    return false;
  };
  let view = host.window_handle().cast::<NSView>();
  let Some(view) = (unsafe { Retained::<NSView>::retain(view) }) else {
    return false;
  };
  let Some(window) = view.window() else {
    return false;
  };

  window.makeKeyAndOrderFront(None);
  window.orderFrontRegardless();
  host.set_focus(1);
  true
}

#[cfg(windows)]
fn focus_remote_devtools_window(browser: &Browser) -> bool {
  use windows::Win32::{
    Foundation::HWND,
    UI::WindowsAndMessaging::{
      GA_ROOT, GetAncestor, IsWindow, SW_RESTORE, SetForegroundWindow, ShowWindow,
    },
  };

  let Some(host) = browser.host() else {
    return false;
  };
  let hwnd = HWND(host.window_handle().0 as _);
  if !unsafe { IsWindow(Some(hwnd)).as_bool() } {
    return false;
  }
  let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
  let window = if root.0.is_null() { hwnd } else { root };
  unsafe {
    let _ = ShowWindow(window, SW_RESTORE);
    let _ = SetForegroundWindow(window);
    host.set_focus(1);
  }
  // SetForegroundWindow can be denied by Windows' foreground-lock policy even
  // though the existing native window is still valid. Do not create a
  // duplicate in that case.
  true
}

#[cfg(any(windows, target_os = "macos"))]
fn focus_existing_remote_devtools_window(target_id: &str) -> bool {
  let browser = remote_devtools_windows()
    .lock()
    .unwrap()
    .get(target_id)
    .cloned();
  let Some(browser) = browser else {
    return false;
  };

  if focus_remote_devtools_window(&browser) {
    trace_devtools(format!(
      "remote_devtools.window.focused target_id={target_id} browser_id={}",
      browser.identifier()
    ));
    true
  } else {
    unregister_remote_devtools_window(target_id, browser.identifier());
    false
  }
}

#[cfg(any(windows, target_os = "macos"))]
wrap_life_span_handler! {
  struct RemoteDevToolsLifeSpanHandler {
    target_id: String,
  }

  impl LifeSpanHandler {
    fn on_after_created(&self, browser: Option<&mut Browser>) {
      if let Some(browser) = browser {
        register_remote_devtools_window(&self.target_id, browser);
      }
    }

    fn on_before_close(&self, browser: Option<&mut Browser>) {
      if let Some(browser) = browser {
        unregister_remote_devtools_window(&self.target_id, browser.identifier());
      }
    }
  }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug)]
struct DevToolsPopupPolicy {
  runtime_style: RuntimeStyle,
  use_default_window: bool,
  has_native_parent: bool,
  windowless: bool,
  use_dedicated_client: bool,
}

#[cfg(any(target_os = "macos", test))]
fn macos_devtools_popup_policy() -> DevToolsPopupPolicy {
  DevToolsPopupPolicy {
    runtime_style: RuntimeStyle::CHROME,
    use_default_window: true,
    has_native_parent: false,
    windowless: false,
    use_dedicated_client: true,
  }
}

#[cfg(any(target_os = "macos", test))]
fn macos_devtools_popup_bounds(slot: u32) -> Rect {
  const CASCADE_SLOTS: u32 = 4;
  const CASCADE_OFFSET: i32 = 36;
  let offset = i32::try_from(slot % CASCADE_SLOTS).unwrap_or_default() * CASCADE_OFFSET;
  Rect {
    x: 64 + offset,
    y: 64 + offset,
    width: 980,
    height: 720,
  }
}

#[cfg(target_os = "macos")]
fn next_macos_devtools_popup_bounds() -> Rect {
  static NEXT_SLOT: AtomicU32 = AtomicU32::new(0);
  macos_devtools_popup_bounds(NEXT_SLOT.fetch_add(1, Ordering::Relaxed))
}

fn devtools_trace_path() -> &'static PathBuf {
  static TRACE_PATH: OnceLock<PathBuf> = OnceLock::new();
  TRACE_PATH.get_or_init(|| {
    let override_path = std::env::var_os("ARDOR_CEF_DEVTOOLS_TRACE_FILE").map(PathBuf::from);
    override_path.unwrap_or_else(|| std::env::temp_dir().join("ardor-cef-devtools-trace.log"))
  })
}

pub(crate) fn trace_devtools(event: impl AsRef<str>) {
  let timestamp_ms = SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_millis())
    .unwrap_or_default();
  let line = format!(
    "[ardor-devtools] ts_ms={timestamp_ms} pid={} tid={:?} {}",
    process::id(),
    std::thread::current().id(),
    event.as_ref()
  );

  eprintln!("{line}");

  if let Ok(mut file) = OpenOptions::new()
    .create(true)
    .append(true)
    .open(devtools_trace_path())
  {
    let _ = writeln!(file, "{line}");
    let _ = file.flush();
    let _ = file.sync_data();
  }
}

#[cfg(windows)]
fn with_chrome_runtime(mut window_info: WindowInfo) -> WindowInfo {
  // The inspected browser is windowless and therefore Alloy-style, but CEF's
  // native DevTools popup must be windowed Chrome-style. Creating the DevTools
  // browser as Alloy is unsupported and triggers a Chromium CHECK on Windows.
  window_info.runtime_style = RuntimeStyle::CHROME;
  window_info
}

#[cfg(windows)]
fn devtools_window_info_for_parent(parent: cef::sys::cef_window_handle_t) -> WindowInfo {
  with_chrome_runtime(WindowInfo::default().set_as_popup(parent, "Developer Tools"))
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn devtools_window_info(host: &BrowserHost) -> WindowInfo {
  let _ = host;
  WindowInfo::default()
}

#[cfg(target_os = "macos")]
fn macos_devtools_window_info() -> WindowInfo {
  let policy = macos_devtools_popup_policy();
  debug_assert!(!policy.has_native_parent);
  let mut window_info = WindowInfo::default();
  window_info.window_name = CefString::from("Developer Tools");
  window_info.bounds = macos_devtools_popup_bounds(0);
  window_info.parent_view = std::ptr::null_mut();
  window_info.windowless_rendering_enabled = i32::from(policy.windowless);
  window_info.runtime_style = policy.runtime_style;
  window_info
}

#[cfg(target_os = "macos")]
pub(super) fn configure_macos_devtools_popup(
  window_info: Option<&mut WindowInfo>,
  client: Option<&mut Option<Client>>,
  use_default_window: Option<&mut std::os::raw::c_int>,
) {
  let policy = macos_devtools_popup_policy();
  if let Some(window_info) = window_info {
    *window_info = macos_devtools_window_info();
    window_info.bounds = next_macos_devtools_popup_bounds();
  }
  if policy.use_dedicated_client {
    if let Some(client) = client {
      *client = Some(devtools_client());
    }
  }
  if let Some(use_default_window) = use_default_window {
    *use_default_window = i32::from(policy.use_default_window);
  }
}

#[cfg(windows)]
pub(super) fn configure_devtools_popup(
  browser: Option<&mut Browser>,
  window_info: Option<&mut WindowInfo>,
  client: Option<&mut Option<Client>>,
  use_default_window: Option<&mut std::os::raw::c_int>,
) {
  let Some(use_default_window) = use_default_window else {
    trace_devtools("configure_devtools_popup: missing use_default_window pointer");
    return;
  };
  let browser_id = browser
    .as_ref()
    .map(|browser| browser.identifier())
    .unwrap_or_default();
  let incoming_runtime_style = window_info
    .as_ref()
    .map(|window_info| window_info.runtime_style)
    .unwrap_or(RuntimeStyle::DEFAULT);
  trace_devtools(format!(
    "configure_devtools_popup: browser_id={} incoming_runtime_style={:?}",
    browser_id, incoming_runtime_style
  ));
  if let Some(window_info) = window_info {
    let null_parent = cef::sys::HWND(std::ptr::null_mut());
    *window_info = devtools_window_info_for_parent(null_parent);
  }
  if let Some(client) = client {
    *client = Some(devtools_client());
  }
  // Asking CEF for its default native window prevents it from inheriting the
  // source browser's windowless Alloy host.
  *use_default_window = 1;
  trace_devtools(
    "configure_devtools_popup: using dedicated client and default native Chrome window",
  );
}

#[cfg(all(not(windows), not(target_os = "macos")))]
pub(crate) fn show_dev_tools(host: &BrowserHost, inspect_element_at: Option<&Point>) {
  if !browser_devtools_enabled() {
    trace_devtools("show_dev_tools.skipped disabled");
    return;
  }
  // ShowDevTools takes C++ references for WindowInfo and BrowserSettings, so
  // all three creation arguments must be present on the first call. The
  // application client must not be reused because its lifecycle handler owns
  // the preview webview and would treat the DevTools window as that view.
  trace_devtools(format!(
    "show_dev_tools.begin runtime_style={:?} parent_handle={:?} has_devtools={} inspect={:?}",
    host.runtime_style(),
    host.window_handle(),
    host.has_dev_tools(),
    inspect_element_at.map(|point| (point.x, point.y))
  ));
  let window_info = devtools_window_info(host);
  let mut client = devtools_client();
  let settings = BrowserSettings::default();
  trace_devtools(format!(
    "show_dev_tools.call windowless={} shared_texture={} external_begin_frame={} runtime_style={:?}",
    window_info.windowless_rendering_enabled,
    window_info.shared_texture_enabled,
    window_info.external_begin_frame_enabled,
    window_info.runtime_style
  ));
  host.show_dev_tools(
    Some(&window_info),
    Some(&mut client),
    Some(&settings),
    inspect_element_at,
  );
  trace_devtools(format!(
    "show_dev_tools.end has_devtools={}",
    host.has_dev_tools()
  ));
}

fn inspect_element_command_id() -> std::os::raw::c_int {
  MenuId::USER_FIRST.get_raw() as std::os::raw::c_int
}

fn uses_custom_inspect_item(devtools_enabled: bool, runtime_style: RuntimeStyle) -> bool {
  devtools_enabled && runtime_style == RuntimeStyle::ALLOY
}

#[cfg(any(windows, target_os = "macos", test))]
#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
struct RemoteDebuggingTarget {
  #[serde(default)]
  id: String,
  #[serde(default, rename = "devtoolsFrontendUrl")]
  devtools_frontend_url: String,
  #[serde(default, rename = "type")]
  target_type: String,
  #[serde(default)]
  url: String,
}

#[cfg(any(windows, target_os = "macos", test))]
fn remote_debugging_frontend_url(port: i32, frontend_url: &str) -> Option<String> {
  if port <= 0 {
    return None;
  }
  if frontend_url.starts_with('/') {
    return Some(format!("http://127.0.0.1:{port}{frontend_url}"));
  }
  let url = Url::parse(frontend_url).ok()?;
  (url.scheme() == "https" && url.host_str() == Some("chrome-devtools-frontend.appspot.com"))
    .then(|| url.to_string())
}

#[cfg(any(windows, target_os = "macos", test))]
fn parse_remote_debugging_targets(response: &str) -> Option<Vec<RemoteDebuggingTarget>> {
  let body = response
    .split_once("\r\n\r\n")
    .map(|(_, body)| body)
    .unwrap_or(response);
  serde_json::from_str(body).ok()
}

#[cfg(any(windows, target_os = "macos", test))]
fn parse_remote_debugging_target_id(result: &[u8]) -> Result<String, String> {
  let result: serde_json::Value = serde_json::from_slice(result)
    .map_err(|err| format!("invalid Target.getTargetInfo result: {err}"))?;
  let target_id = result
    .get("targetInfo")
    .and_then(|target_info| target_info.get("targetId"))
    .and_then(serde_json::Value::as_str)
    .filter(|target_id| !target_id.is_empty())
    .ok_or_else(|| "Target.getTargetInfo returned no target ID".to_string())?;
  Ok(target_id.to_string())
}

#[cfg(any(windows, target_os = "macos", test))]
fn complete_http_response_len(response: &[u8]) -> Result<Option<usize>, String> {
  let Some(header_end) = response.windows(4).position(|window| window == b"\r\n\r\n") else {
    return Ok(None);
  };
  let headers = std::str::from_utf8(&response[..header_end])
    .map_err(|_| "HTTP response headers are not UTF-8".to_string())?;
  let status = headers.lines().next().unwrap_or_default();
  if !(status.starts_with("HTTP/1.1 200 ") || status.starts_with("HTTP/1.0 200 ")) {
    return Err(format!("remote debugging endpoint returned {status}"));
  }
  let content_length = headers.lines().skip(1).find_map(|line| {
    let (name, value) = line.split_once(':')?;
    name
      .eq_ignore_ascii_case("content-length")
      .then(|| value.trim().parse::<usize>().ok())
      .flatten()
  });
  content_length
    .map(|length| {
      header_end
        .checked_add(4)
        .and_then(|body_start| body_start.checked_add(length))
        .ok_or_else(|| "HTTP response length overflow".to_string())
    })
    .transpose()
}

#[cfg(any(windows, target_os = "macos", test))]
fn read_remote_debugging_response(stream: &mut TcpStream) -> Result<String, String> {
  const MAX_RESPONSE_SIZE: usize = 1024 * 1024;
  let mut response = Vec::new();
  let mut buffer = [0_u8; 8192];

  loop {
    match stream.read(&mut buffer) {
      Ok(0) => break,
      Ok(size) => {
        response.extend_from_slice(&buffer[..size]);
        if response.len() > MAX_RESPONSE_SIZE {
          return Err("remote debugging response exceeds 1 MiB".to_string());
        }
        if let Some(expected_len) = complete_http_response_len(&response)? {
          if expected_len > MAX_RESPONSE_SIZE {
            return Err("remote debugging response exceeds 1 MiB".to_string());
          }
          if response.len() >= expected_len {
            response.truncate(expected_len);
            break;
          }
        }
      }
      Err(err)
        if matches!(
          err.kind(),
          std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ) && std::str::from_utf8(&response)
          .ok()
          .and_then(parse_remote_debugging_targets)
          .is_some() =>
      {
        break;
      }
      Err(err) => return Err(format!("read failed: {err}")),
    }
  }

  String::from_utf8(response).map_err(|_| "remote debugging response is not UTF-8".to_string())
}

#[cfg(any(windows, target_os = "macos", test))]
fn remote_debugging_list_request(port: i32) -> Option<String> {
  (port > 0).then(|| {
    format!(
      "GET /json/list HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    )
  })
}

#[cfg(any(windows, target_os = "macos", test))]
fn select_remote_debugging_target_by_id(
  targets: &[RemoteDebuggingTarget],
  target_id: &str,
) -> Option<RemoteDebuggingTarget> {
  if target_id.is_empty() {
    return None;
  }

  targets
    .iter()
    .find(|target| {
      target.id == target_id
        && target.target_type == "page"
        && !target.devtools_frontend_url.is_empty()
    })
    .cloned()
}

#[cfg(any(windows, target_os = "macos", test))]
fn fetch_remote_debugging_targets(port: i32) -> Result<Vec<RemoteDebuggingTarget>, String> {
  if port <= 0 {
    return Err("remote debugging port is disabled".to_string());
  }
  let mut stream = TcpStream::connect_timeout(
    &(Ipv4Addr::LOCALHOST, port as u16).into(),
    Duration::from_millis(500),
  )
  .map_err(|err| format!("connect failed: {err}"))?;
  let _ = stream.set_read_timeout(Some(Duration::from_millis(750)));
  let _ = stream.set_write_timeout(Some(Duration::from_millis(750)));
  let request = remote_debugging_list_request(port)
    .ok_or_else(|| "remote debugging port is disabled".to_string())?;
  stream
    .write_all(request.as_bytes())
    .map_err(|err| format!("write failed: {err}"))?;

  let response = read_remote_debugging_response(&mut stream)?;
  parse_remote_debugging_targets(&response).ok_or_else(|| "invalid JSON response".to_string())
}

#[cfg(any(windows, target_os = "macos"))]
fn resolve_remote_debugging_frontend(port: i32, target_id: &str) -> Result<String, String> {
  let targets = fetch_remote_debugging_targets(port)?;
  let target = select_remote_debugging_target_by_id(&targets, target_id)
    .ok_or_else(|| format!("page target {target_id} not found"))?;
  remote_debugging_frontend_url(port, target.devtools_frontend_url.as_str())
    .ok_or_else(|| "invalid DevTools frontend URL".to_string())
}

#[cfg(any(windows, target_os = "macos"))]
fn open_remote_debugging_frontend(target_id: String, url: String) -> Result<(), String> {
  if focus_existing_remote_devtools_window(&target_id) {
    trace_devtools(format!("remote_devtools.open.reused target_id={target_id}"));
    return Ok(());
  }

  trace_devtools(format!(
    "remote_devtools.open.begin target_id={target_id} frontend_is_loopback={} on_ui_thread={}",
    url.starts_with("http://127.0.0.1:"),
    cef::currently_on(cef::sys::cef_thread_id_t::TID_UI.into()) != 0
  ));

  #[cfg(windows)]
  let window_info = {
    let null_parent = cef::sys::HWND(std::ptr::null_mut());
    let mut window_info = WindowInfo::default().set_as_popup(null_parent, "Developer Tools");
    // This is a normal browser that hosts the official DevTools frontend, not a
    // CefBrowserHost::ShowDevTools window. Alloy is valid here and avoids the
    // unsupported ShowDevTools + windowless-source path that crashes CEF 150.
    window_info.runtime_style = RuntimeStyle::ALLOY;
    window_info
  };
  #[cfg(target_os = "macos")]
  let window_info = {
    let mut window_info = macos_devtools_window_info();
    window_info.bounds = next_macos_devtools_popup_bounds();
    window_info
  };
  let settings = BrowserSettings::default();
  let mut client = remote_devtools_client(target_id.clone());
  let initial_url = CefString::from(url.as_str());
  let mut request_context = request_context_get_global_context()
    .ok_or_else(|| "global request context is unavailable".to_string())?;
  cef::browser_host_create_browser_sync(
    Some(&window_info),
    Some(&mut client),
    Some(&initial_url),
    Some(&settings),
    None,
    Some(&mut request_context),
  )
  .ok_or_else(|| "failed to create DevTools frontend browser".to_string())?;

  trace_devtools(format!("remote_devtools.open.end target_id={target_id}"));
  Ok(())
}

#[cfg(any(windows, target_os = "macos"))]
wrap_task! {
  struct OpenRemoteDevToolsTask {
    target_id: String,
    url: String,
  }

  impl Task {
    fn execute(&self) {
      if let Err(err) =
        open_remote_debugging_frontend(self.target_id.clone(), self.url.clone())
      {
        trace_devtools(format!("remote_devtools.open.failed error={err}"));
      }
    }
  }
}

#[cfg(any(windows, target_os = "macos"))]
static NEXT_TARGET_INFO_MESSAGE_ID: AtomicI32 = AtomicI32::new(2_000_000);

#[cfg(any(windows, target_os = "macos"))]
type RemoteTargetIdCallback = Box<dyn FnOnce(Result<String, String>) + Send + 'static>;

#[cfg(any(windows, target_os = "macos"))]
cef::wrap_dev_tools_message_observer! {
  struct RemoteTargetIdDevToolsObserver {
    message_id: i32,
    callback: Arc<Mutex<Option<RemoteTargetIdCallback>>>,
    registration: Arc<Mutex<Option<cef::Registration>>>,
  }

  impl DevToolsMessageObserver {
    fn on_dev_tools_method_result(
      &self,
      _browser: Option<&mut Browser>,
      message_id: std::os::raw::c_int,
      success: std::os::raw::c_int,
      result: Option<&[u8]>,
    ) {
      if message_id != self.message_id {
        return;
      }

      let Some(callback) = self.callback.lock().unwrap().take() else {
        return;
      };
      let target_id = if success != 0 {
        result
          .ok_or_else(|| "Target.getTargetInfo returned no result".to_string())
          .and_then(parse_remote_debugging_target_id)
      } else {
        Err("Target.getTargetInfo failed".to_string())
      };

      let _ = self.registration.lock().unwrap().take();
      callback(target_id);
    }
  }
}

#[cfg(any(windows, target_os = "macos"))]
fn request_remote_debugging_target_id(
  host: &BrowserHost,
  callback: RemoteTargetIdCallback,
) -> Result<(), String> {
  let message_id = NEXT_TARGET_INFO_MESSAGE_ID.fetch_add(1, Ordering::Relaxed);
  let callback = Arc::new(Mutex::new(Some(callback)));
  let registration = Arc::new(Mutex::new(None));
  let mut observer = RemoteTargetIdDevToolsObserver::new(
    message_id,
    Arc::clone(&callback),
    Arc::clone(&registration),
  );
  let observer_registration = host
    .add_dev_tools_message_observer(Some(&mut observer))
    .ok_or_else(|| "failed to register Target.getTargetInfo observer".to_string())?;
  *registration.lock().unwrap() = Some(observer_registration);

  let method = CefString::from("Target.getTargetInfo");
  if host.execute_dev_tools_method(message_id, Some(&method), None) == 0 {
    let _ = callback.lock().unwrap().take();
    let _ = registration.lock().unwrap().take();
    return Err("failed to execute Target.getTargetInfo".to_string());
  }

  Ok(())
}

#[cfg(any(windows, target_os = "macos"))]
fn spawn_remote_debugging_frontend_resolver(port: i32, target_id: String) -> Result<(), String> {
  std::thread::Builder::new()
    .name("ardor-devtools-resolver".to_string())
    .spawn(move || {
      trace_devtools(format!(
        "remote_devtools.resolve.begin port={port} target_id={target_id}"
      ));
      let url = match resolve_remote_debugging_frontend(port, &target_id) {
        Ok(url) => url,
        Err(err) => {
          trace_devtools(format!(
            "remote_devtools.resolve.failed port={port} target_id={target_id} error={err}"
          ));
          return;
        }
      };
      trace_devtools(format!(
        "remote_devtools.resolve.end port={port} target_id={target_id}"
      ));
      let mut task = OpenRemoteDevToolsTask::new(target_id, url);
      let posted = cef::post_task(cef::sys::cef_thread_id_t::TID_UI.into(), Some(&mut task));
      trace_devtools(format!("remote_devtools.open.posted result={posted}"));
    })
    .map(|_| ())
    .map_err(|err| format!("failed to spawn resolver thread: {err}"))
}

#[cfg(any(windows, target_os = "macos"))]
pub(crate) fn schedule_remote_debugging_frontend(host: &BrowserHost) -> Result<(), String> {
  let port = cef_remote_debugging_port();
  if port <= 0 {
    return Err("remote debugging port is disabled".to_string());
  }
  trace_devtools(format!(
    "remote_devtools.target_info.scheduled port={port} on_ui_thread={}",
    cef::currently_on(cef::sys::cef_thread_id_t::TID_UI.into()) != 0
  ));
  request_remote_debugging_target_id(
    host,
    Box::new(move |target_id| match target_id {
      Ok(target_id) => {
        trace_devtools(format!(
          "remote_devtools.target_info.resolved port={port} target_id={target_id}"
        ));
        if let Err(err) = spawn_remote_debugging_frontend_resolver(port, target_id) {
          trace_devtools(format!(
            "remote_devtools.resolve.schedule_failed port={port} error={err}"
          ));
        }
      }
      Err(err) => trace_devtools(format!(
        "remote_devtools.target_info.failed port={port} error={err}"
      )),
    }),
  )
}

wrap_context_menu_handler! {
  pub struct TauriCefContextMenuHandler {
    devtools_enabled: bool,
    label: String,
    webview_id: u32,
  }

  impl ContextMenuHandler {
    fn on_before_context_menu(
      &self,
      browser: Option<&mut Browser>,
      _frame: Option<&mut Frame>,
      _params: Option<&mut ContextMenuParams>,
      model: Option<&mut MenuModel>,
    ) {
      let runtime_style = browser
        .as_ref()
        .and_then(|browser| browser.host())
        .map(|host| host.runtime_style())
        .unwrap_or(RuntimeStyle::DEFAULT);
      trace_devtools(format!(
        "on_before_context_menu.enter label={:?} webview_id={} browser_id={} runtime_style={:?} devtools_enabled={}",
        self.label,
        self.webview_id,
        browser.as_ref().map(|browser| browser.identifier()).unwrap_or_default(),
        runtime_style,
        self.devtools_enabled
      ));

      let Some(model) = model else {
        trace_devtools(format!(
          "on_before_context_menu.missing_model label={:?} webview_id={}",
          self.label, self.webview_id
        ));
        return;
      };

      for index in 0..model.count() {
        trace_devtools(format!(
          "on_before_context_menu.item label={:?} webview_id={} index={} command_id={}",
          self.label,
          self.webview_id,
          index,
          model.command_id_at(index)
        ));
      }

      let custom_inspect = uses_custom_inspect_item(self.devtools_enabled, runtime_style);
      if custom_inspect {
        if model.count() > 0 {
          model.add_separator();
        }
        let label = CefString::from("Inspect");
        model.add_item(inspect_element_command_id(), Some(&label));
      } else if !self.devtools_enabled
        && runtime_style == RuntimeStyle::CHROME
        && model.count() > 0
      {
        // Chrome-style CEF adds Inspect as the final default item. Alloy does
        // not, so only remove it for Chrome-style browsers.
        model.remove_at(model.count() - 1);
      }
      trace_devtools(format!(
        "on_before_context_menu.exit label={:?} webview_id={} custom_inspect={} final_count={}",
        self.label,
        self.webview_id,
        custom_inspect,
        model.count()
      ));
    }

    fn on_context_menu_command(
      &self,
      browser: Option<&mut Browser>,
      _frame: Option<&mut Frame>,
      params: Option<&mut ContextMenuParams>,
      command_id: std::os::raw::c_int,
      _event_flags: EventFlags,
    ) -> std::os::raw::c_int {
      let browser_id = browser.as_ref().map(|browser| browser.identifier()).unwrap_or_default();
      let matched_custom_inspect = self.devtools_enabled && command_id == inspect_element_command_id();
      trace_devtools(format!(
        "on_context_menu_command.enter label={:?} webview_id={} browser_id={} command_id={} custom_command_id={} matched_custom_inspect={} point={:?}",
        self.label,
        self.webview_id,
        browser_id,
        command_id,
        inspect_element_command_id(),
        matched_custom_inspect,
        params.as_ref().map(|params| (params.xcoord(), params.ycoord()))
      ));
      if !matched_custom_inspect {
        trace_devtools(format!(
          "on_context_menu_command.delegate_to_cef label={:?} webview_id={} command_id={}",
          self.label, self.webview_id, command_id
        ));
        return 0;
      }

      let Some((host, params)) = browser
        .and_then(|browser| browser.host())
        .zip(params)
      else {
        trace_devtools(format!(
          "on_context_menu_command: missing browser or params browser_id={browser_id}"
        ));
        return 0;
      };
      let point = Point {
        x: params.xcoord(),
        y: params.ycoord(),
      };
      trace_devtools(format!(
        "on_context_menu_command.inspect label={:?} webview_id={} browser_id={} runtime_style={:?} has_devtools={} point=({}, {})",
        self.label,
        self.webview_id,
        browser_id,
        host.runtime_style(),
        host.has_dev_tools(),
        point.x,
        point.y
      ));
      #[cfg(any(windows, target_os = "macos"))]
      match schedule_remote_debugging_frontend(&host) {
        Ok(()) => trace_devtools(format!(
          "on_context_menu_command.remote_devtools_scheduled label={:?} webview_id={}",
          self.label, self.webview_id
        )),
        Err(err) => trace_devtools(format!(
          "on_context_menu_command.remote_devtools_failed label={:?} webview_id={} error={err}",
          self.label, self.webview_id
        )),
      }
      #[cfg(all(not(windows), not(target_os = "macos")))]
      show_dev_tools(&host, Some(&point));
      trace_devtools(format!(
        "on_context_menu_command.return label={:?} webview_id={}",
        self.label, self.webview_id
      ));
      1
    }
  }
}

#[cfg(test)]
mod tests {
  use super::{
    contains_only_devtools_network_permissions, devtools_client, fetch_remote_debugging_targets,
    inspect_element_command_id, is_trusted_devtools_origin, macos_devtools_popup_bounds,
    macos_devtools_popup_policy, parse_remote_debugging_target_id, parse_remote_debugging_targets,
    remote_debugging_frontend_url, select_remote_debugging_target_by_id, uses_custom_inspect_item,
  };
  use cef::{ImplClient, MenuId, RuntimeStyle};

  #[test]
  fn adds_custom_inspect_only_for_enabled_alloy_browsers() {
    assert!(uses_custom_inspect_item(true, RuntimeStyle::ALLOY));
    assert!(!uses_custom_inspect_item(true, RuntimeStyle::CHROME));
    assert!(!uses_custom_inspect_item(false, RuntimeStyle::ALLOY));
  }

  #[test]
  fn inspect_command_uses_cef_user_command_range() {
    let command_id = inspect_element_command_id() as u32;

    assert!(command_id >= MenuId::USER_FIRST.get_raw());
    assert!(command_id <= MenuId::USER_LAST.get_raw());
  }

  #[test]
  fn devtools_uses_a_dedicated_client_without_preview_handlers() {
    let client = devtools_client();

    assert!(client.life_span_handler().is_none());
    assert!(client.render_handler().is_none());
    assert!(client.request_handler().is_none());
  }

  #[test]
  fn macos_devtools_uses_a_host_bound_native_chrome_window() {
    let policy = macos_devtools_popup_policy();

    assert_eq!(policy.runtime_style, RuntimeStyle::CHROME);
    assert!(policy.use_default_window);
    assert!(!policy.has_native_parent);
    assert!(!policy.windowless);
    assert!(policy.use_dedicated_client);
  }

  #[test]
  fn macos_devtools_windows_are_cascaded_without_leaving_the_default_viewport() {
    let first = macos_devtools_popup_bounds(0);
    let second = macos_devtools_popup_bounds(1);
    let wrapped = macos_devtools_popup_bounds(4);

    assert_eq!(
      (first.x, first.y, first.width, first.height),
      (64, 64, 980, 720)
    );
    assert_eq!((second.x, second.y), (100, 100));
    assert_eq!(
      (wrapped.x, wrapped.y, wrapped.width, wrapped.height),
      (first.x, first.y, first.width, first.height)
    );
  }

  #[test]
  fn trusts_only_the_official_or_loopback_devtools_origin() {
    assert!(is_trusted_devtools_origin(
      "https://chrome-devtools-frontend.appspot.com"
    ));
    assert!(is_trusted_devtools_origin("http://127.0.0.1:50000"));
    assert!(!is_trusted_devtools_origin(
      "https://chrome-devtools-frontend.appspot.com.evil.test"
    ));
    assert!(!is_trusted_devtools_origin("https://evil.test"));
  }

  #[test]
  fn grants_only_local_network_permissions_to_devtools() {
    let local = cef::sys::cef_permission_request_types_t::CEF_PERMISSION_TYPE_LOCAL_NETWORK as u32;
    let loopback =
      cef::sys::cef_permission_request_types_t::CEF_PERMISSION_TYPE_LOOPBACK_NETWORK as u32;
    let clipboard = cef::sys::cef_permission_request_types_t::CEF_PERMISSION_TYPE_CLIPBOARD as u32;

    assert!(contains_only_devtools_network_permissions(local));
    assert!(contains_only_devtools_network_permissions(local | loopback));
    assert!(!contains_only_devtools_network_permissions(0));
    assert!(!contains_only_devtools_network_permissions(
      local | clipboard
    ));
  }

  #[test]
  fn accepts_only_official_or_loopback_devtools_frontend_urls() {
    assert!(
      remote_debugging_frontend_url(
        50_000,
        "https://chrome-devtools-frontend.appspot.com/serve_rev/@revision/inspector.html?ws=target"
      )
      .is_some()
    );
    assert_eq!(
      remote_debugging_frontend_url(50_000, "/devtools/inspector.html?ws=target").unwrap(),
      "http://127.0.0.1:50000/devtools/inspector.html?ws=target"
    );
    assert!(remote_debugging_frontend_url(50_000, "https://evil.test/").is_none());
  }

  #[test]
  fn fetches_targets_without_waiting_for_keep_alive_to_close() {
    use std::{
      io::{Read, Write},
      net::TcpListener,
      sync::mpsc,
      thread,
      time::Duration,
    };

    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let (release_tx, release_rx) = mpsc::channel();
    let server = thread::spawn(move || {
      let (mut stream, _) = listener.accept().unwrap();
      let mut request = [0_u8; 1024];
      assert!(stream.read(&mut request).unwrap() > 0);
      let body = r#"[{"id":"target-a","type":"page","url":"https://example.test/","devtoolsFrontendUrl":"/devtools/inspector.html?ws=target-a"}]"#;
      write!(
        stream,
        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: keep-alive\r\n\r\n{}",
        body.len(),
        body
      )
      .unwrap();
      stream.flush().unwrap();
      release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    });

    let targets = fetch_remote_debugging_targets(i32::from(port)).unwrap();
    release_tx.send(()).unwrap();
    server.join().unwrap();

    assert_eq!(targets.len(), 1);
    assert_eq!(targets[0].url, "https://example.test/");
    assert_eq!(
      select_remote_debugging_target_by_id(&targets, "target-a")
        .unwrap()
        .url,
      "https://example.test/"
    );
  }

  #[test]
  fn selects_the_exact_remote_target_when_page_urls_are_identical() {
    let targets = parse_remote_debugging_targets(
      r#"[
        {"id":"target-a","type":"page","url":"https://example.test/","devtoolsFrontendUrl":"/devtools/inspector.html?ws=target-a"},
        {"id":"target-b","type":"page","url":"https://example.test/","devtoolsFrontendUrl":"/devtools/inspector.html?ws=target-b"}
      ]"#,
    )
    .unwrap();

    let selected = select_remote_debugging_target_by_id(&targets, "target-b").unwrap();

    assert_eq!(selected.id, "target-b");
    assert!(selected.devtools_frontend_url.ends_with("ws=target-b"));
  }

  #[test]
  fn parses_the_target_id_reported_by_the_exact_browser_host() {
    assert_eq!(
      parse_remote_debugging_target_id(
        br#"{"targetInfo":{"targetId":"target-b","type":"page","url":"https://example.test/"}}"#
      )
      .unwrap(),
      "target-b"
    );
    assert!(parse_remote_debugging_target_id(br#"{"targetInfo":{"targetId":""}}"#).is_err());
    assert!(parse_remote_debugging_target_id(br#"{}"#).is_err());
  }

  #[cfg(windows)]
  #[test]
  fn devtools_window_is_a_native_chrome_popup() {
    let parent = cef::sys::HWND(std::ptr::null_mut());
    let window_info = super::devtools_window_info_for_parent(parent);

    assert_eq!(window_info.parent_window, parent);
    assert_eq!(window_info.runtime_style, RuntimeStyle::CHROME);
    assert_ne!(window_info.style, 0);
    assert_eq!(window_info.windowless_rendering_enabled, 0);
  }
}
