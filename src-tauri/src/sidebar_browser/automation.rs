use std::{
    sync::{
        atomic::{AtomicI32, Ordering},
        mpsc, Arc, Mutex,
    },
    time::Duration,
};

use cef::{
    rc::Rc as _, DevToolsMessageObserver, ImplBrowser as _, ImplBrowserHost as _,
    ImplDevToolsMessageObserver, WrapDevToolsMessageObserver,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::runtime::DesktopWebview as Webview;

const MAX_AUTOMATION_REQUEST_BYTES: usize = 64 * 1024;
const MAX_AUTOMATION_RESULT_BYTES: usize = 16 * 1024 * 1024;
const AUTOMATION_TIMEOUT: Duration = Duration::from_secs(10);

const ALLOWED_DEVTOOLS_METHODS: &[&str] = &[
    "Accessibility.getFullAXTree",
    "CSS.getComputedStyleForNode",
    "DOM.describeNode",
    "DOM.disable",
    "DOM.enable",
    "DOM.focus",
    "DOM.getAttributes",
    "DOM.getBoxModel",
    "DOM.getDocument",
    "DOM.getOuterHTML",
    "DOM.querySelector",
    "DOM.querySelectorAll",
    "DOMSnapshot.captureSnapshot",
    "Input.dispatchKeyEvent",
    "Input.dispatchMouseEvent",
    "Input.insertText",
    "Page.captureScreenshot",
    "Page.getLayoutMetrics",
    "Performance.getMetrics",
    "Runtime.evaluate",
];

fn empty_params() -> Value {
    Value::Object(Map::new())
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserAutomationRequest {
    pub(crate) method: String,
    #[serde(default = "empty_params")]
    pub(crate) params: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowserAutomationResponse {
    pub(crate) generation: u64,
    pub(crate) result: Value,
}

fn validate_devtools_method(method: &str) -> Result<(), String> {
    if method.is_empty() || method.len() > 128 || !method.is_ascii() {
        return Err("browser automation method is invalid".to_string());
    }
    if !ALLOWED_DEVTOOLS_METHODS.contains(&method) {
        return Err(format!("browser automation method {method} is not allowed"));
    }
    Ok(())
}

fn build_devtools_message(
    message_id: i32,
    request: &BrowserAutomationRequest,
) -> Result<Vec<u8>, String> {
    validate_devtools_method(&request.method)?;
    if !request.params.is_object() {
        return Err("browser automation params must be a JSON object".to_string());
    }
    let mut params = request.params.clone();
    if request.method == "Runtime.evaluate" {
        let params = params
            .as_object_mut()
            .expect("browser automation params were checked as an object");
        let expression = params
            .get("expression")
            .and_then(Value::as_str)
            .ok_or_else(|| "Runtime.evaluate requires a string expression".to_string())?;
        if expression.is_empty() || expression.len() > 32 * 1024 {
            return Err("Runtime.evaluate expression must contain at most 32768 bytes".to_string());
        }
        for forbidden in [
            "allowUnsafeEvalBlockedByCSP",
            "contextId",
            "includeCommandLineAPI",
            "objectGroup",
            "serializationOptions",
            "uniqueContextId",
        ] {
            if params.contains_key(forbidden) {
                return Err(format!(
                    "Runtime.evaluate parameter {forbidden} is not allowed"
                ));
            }
        }
        params.insert("awaitPromise".to_string(), Value::Bool(true));
        params.insert("returnByValue".to_string(), Value::Bool(true));
        params.insert("timeout".to_string(), Value::from(5_000));
        params.insert("userGesture".to_string(), Value::Bool(false));
    }
    let message = serde_json::to_vec(&json!({
        "id": message_id,
        "method": request.method,
        "params": params,
    }))
    .map_err(|error| format!("failed to serialize browser automation request: {error}"))?;
    if message.len() > MAX_AUTOMATION_REQUEST_BYTES {
        return Err("browser automation request is too large".to_string());
    }
    Ok(message)
}

fn parse_devtools_result(result: &[u8]) -> Result<Value, String> {
    if result.len() > MAX_AUTOMATION_RESULT_BYTES {
        return Err("browser automation result is too large".to_string());
    }
    serde_json::from_slice(result)
        .map_err(|error| format!("browser automation returned invalid JSON: {error}"))
}

fn copy_bounded_devtools_result(result: Option<&[u8]>) -> Result<Vec<u8>, String> {
    let result = result.unwrap_or_default();
    if result.len() > MAX_AUTOMATION_RESULT_BYTES {
        return Err("browser automation result is too large".to_string());
    }
    Ok(result.to_vec())
}

static NEXT_AUTOMATION_MESSAGE_ID: AtomicI32 = AtomicI32::new(3_000_000);
type AutomationResultSender = mpsc::SyncSender<Result<(bool, Vec<u8>), String>>;

cef::wrap_dev_tools_message_observer! {
    struct BrowserAutomationObserver {
        message_id: i32,
        sender: Arc<Mutex<Option<AutomationResultSender>>>,
        registration: Arc<Mutex<Option<cef::Registration>>>,
    }

    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(
            &self,
            _browser: Option<&mut cef::Browser>,
            message_id: std::os::raw::c_int,
            success: std::os::raw::c_int,
            result: Option<&[u8]>,
        ) {
            if message_id != self.message_id {
                return;
            }
            if let Some(sender) = self
                .sender
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take()
            {
                let response =
                    copy_bounded_devtools_result(result).map(|result| (success != 0, result));
                let _ = sender.try_send(response);
            }
            let _ = self
                .registration
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .take();
        }
    }
}

fn begin_devtools_request(
    host: cef::BrowserHost,
    message_id: i32,
    message: Vec<u8>,
    sender: AutomationResultSender,
    registration: Arc<Mutex<Option<cef::Registration>>>,
) -> Result<(), String> {
    let sender = Arc::new(Mutex::new(Some(sender)));
    let mut observer =
        BrowserAutomationObserver::new(message_id, Arc::clone(&sender), Arc::clone(&registration));
    let observer_registration = host
        .add_dev_tools_message_observer(Some(&mut observer))
        .ok_or_else(|| "failed to register browser automation observer".to_string())?;
    *registration
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(observer_registration);

    if host.send_dev_tools_message(Some(&message)) != 1 {
        let _ = registration
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .take();
        return Err("failed to send browser automation request".to_string());
    }
    Ok(())
}

fn failed_method_message(result: &[u8]) -> String {
    serde_json::from_slice::<Value>(result)
        .ok()
        .and_then(|value| {
            value
                .get("message")
                .or_else(|| value.get("error").and_then(|error| error.get("message")))
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "browser automation method failed".to_string())
}

pub(crate) async fn execute(
    webview: Webview,
    generation: u64,
    request: BrowserAutomationRequest,
) -> Result<BrowserAutomationResponse, String> {
    let message_id = NEXT_AUTOMATION_MESSAGE_ID.fetch_add(1, Ordering::Relaxed);
    let message = build_devtools_message(message_id, &request)?;
    let (sender, receiver) = mpsc::sync_channel(1);
    let error_sender = sender.clone();
    let registration = Arc::new(Mutex::new(None));
    let request_registration = Arc::clone(&registration);
    webview
        .with_webview(move |platform| {
            let result = platform
                .browser()
                .host()
                .ok_or_else(|| "artifact browser host is unavailable".to_string())
                .and_then(|host| {
                    begin_devtools_request(host, message_id, message, sender, request_registration)
                });
            if let Err(error) = result {
                let _ = error_sender.try_send(Err(error));
            }
        })
        .map_err(|error| format!("failed to access artifact browser: {error}"))?;

    let response = tauri::async_runtime::spawn_blocking(move || {
        receiver
            .recv_timeout(AUTOMATION_TIMEOUT)
            .map_err(|error| match error {
                mpsc::RecvTimeoutError::Timeout => {
                    "browser automation request timed out".to_string()
                }
                mpsc::RecvTimeoutError::Disconnected => {
                    "browser automation request ended without a result".to_string()
                }
            })?
    })
    .await
    .map_err(|error| format!("browser automation wait failed: {error}"))
    .and_then(|result| result);
    let _ = registration
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .take();
    let response = response?;

    let (success, result) = response;
    if !success {
        return Err(failed_method_message(&result));
    }
    Ok(BrowserAutomationResponse {
        generation,
        result: parse_devtools_result(&result)?,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_devtools_message, copy_bounded_devtools_result, parse_devtools_result,
        validate_devtools_method, BrowserAutomationRequest, MAX_AUTOMATION_RESULT_BYTES,
    };
    use serde_json::json;

    #[test]
    fn allows_page_scoped_browser_automation_methods() {
        for method in [
            "Accessibility.getFullAXTree",
            "CSS.getComputedStyleForNode",
            "DOM.getDocument",
            "DOM.querySelector",
            "DOMSnapshot.captureSnapshot",
            "Input.dispatchMouseEvent",
            "Page.captureScreenshot",
            "Performance.getMetrics",
            "Runtime.evaluate",
        ] {
            validate_devtools_method(method).unwrap_or_else(|error| {
                panic!("{method} should be available to the artifact browser agent: {error}")
            });
        }
    }

    #[test]
    fn blocks_profile_credentials_and_cross_target_control() {
        for method in [
            "Autofill.setAddresses",
            "Browser.getVersion",
            "DOMStorage.getDOMStorageItems",
            "Network.clearBrowserCookies",
            "Network.deleteCookies",
            "Network.getAllCookies",
            "Network.getCookies",
            "Network.setCookie",
            "Network.setCookies",
            "Page.crash",
            "Page.navigate",
            "Page.setDownloadBehavior",
            "Runtime.terminateExecution",
            "Security.setIgnoreCertificateErrors",
            "Storage.getCookies",
            "Target.getTargets",
        ] {
            assert!(
                validate_devtools_method(method).is_err(),
                "{method} must not cross the artifact browser credential boundary"
            );
        }
    }

    #[test]
    fn builds_and_parses_generation_scoped_devtools_messages() {
        let request = BrowserAutomationRequest {
            method: "Page.captureScreenshot".to_string(),
            params: json!({ "format": "png", "fromSurface": true }),
        };
        let message = build_devtools_message(41, &request).expect("request should serialize");
        let message: serde_json::Value =
            serde_json::from_slice(&message).expect("message should be JSON");

        assert_eq!(message["id"], 41);
        assert_eq!(message["method"], "Page.captureScreenshot");
        assert_eq!(message["params"]["format"], "png");
        assert_eq!(
            parse_devtools_result(br#"{"data":"cG5n"}"#).expect("result should parse"),
            json!({ "data": "cG5n" })
        );
    }

    #[test]
    fn rejects_non_object_params_and_oversized_requests() {
        let scalar = BrowserAutomationRequest {
            method: "Runtime.evaluate".to_string(),
            params: json!("document.title"),
        };
        assert!(build_devtools_message(1, &scalar).is_err());

        let oversized = BrowserAutomationRequest {
            method: "Runtime.evaluate".to_string(),
            params: json!({ "expression": "x".repeat(70 * 1024) }),
        };
        assert!(build_devtools_message(2, &oversized).is_err());
    }

    #[test]
    fn rejects_oversized_devtools_results_before_copying() {
        let below = vec![b'a'; MAX_AUTOMATION_RESULT_BYTES - 1];
        let at_limit = vec![b'b'; MAX_AUTOMATION_RESULT_BYTES];
        let above = vec![b'c'; MAX_AUTOMATION_RESULT_BYTES + 1];

        assert_eq!(
            copy_bounded_devtools_result(Some(&below)).expect("below-limit result should copy"),
            below
        );
        assert_eq!(
            copy_bounded_devtools_result(Some(&at_limit))
                .expect("result exactly at the limit should copy"),
            at_limit
        );
        assert_eq!(
            copy_bounded_devtools_result(None).expect("missing result should be empty"),
            Vec::<u8>::new()
        );
        assert_eq!(
            copy_bounded_devtools_result(Some(&above))
                .expect_err("oversized result must be rejected"),
            "browser automation result is too large"
        );
    }

    #[test]
    fn bounds_runtime_evaluation_to_the_artifact_page() {
        let request = BrowserAutomationRequest {
            method: "Runtime.evaluate".to_string(),
            params: json!({ "expression": "document.title" }),
        };
        let message =
            build_devtools_message(7, &request).expect("safe evaluation should serialize");
        let message: serde_json::Value =
            serde_json::from_slice(&message).expect("message should be JSON");
        assert_eq!(message["params"]["awaitPromise"], true);
        assert_eq!(message["params"]["returnByValue"], true);
        assert_eq!(message["params"]["timeout"], 5_000);
        assert_eq!(message["params"]["userGesture"], false);

        for forbidden in [
            "contextId",
            "includeCommandLineAPI",
            "objectGroup",
            "uniqueContextId",
        ] {
            let request = BrowserAutomationRequest {
                method: "Runtime.evaluate".to_string(),
                params: json!({ "expression": "document.title", (forbidden): true }),
            };
            assert!(build_devtools_message(8, &request).is_err());
        }
    }
}
