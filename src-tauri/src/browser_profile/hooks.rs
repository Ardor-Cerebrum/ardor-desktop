const CREDENTIAL_HOOK_SCRIPT: &str = r#"
(() => {
  if (window.top !== window || location.protocol !== 'https:') return;
  const invoke = window.__TAURI_INTERNALS__?.invoke?.bind(window.__TAURI_INTERNALS__);
  if (typeof invoke !== 'function') return;
  const MAX_USERNAME = 1024;
  const MAX_PASSWORD = 2048;

  const passwordInputFor = (root = document) =>
    root.querySelector?.('input[type="password"]:not([disabled])') ?? null;

  const usernameInputFor = (passwordInput) => {
    const root = passwordInput?.form ?? document;
    return (
      root.querySelector?.('input[autocomplete="username"]:not([disabled])') ??
      root.querySelector?.('input[type="email"]:not([disabled])') ??
      root.querySelector?.('input[type="text"]:not([disabled])') ??
      null
    );
  };

  let lastDetection = '';
  const detect = (passwordInput = passwordInputFor()) => {
    if (!(passwordInput instanceof HTMLInputElement)) return;
    const usernameInput = usernameInputFor(passwordInput);
    const username =
      usernameInput instanceof HTMLInputElement ? usernameInput.value.slice(0, MAX_USERNAME) : '';
    const signature = `${location.origin}\n${username}`;
    if (signature === lastDetection) return;
    lastDetection = signature;
    void invoke('browser_credential_form_detected', { username }).catch(() => {});
  };

  const submit = (passwordInput) => {
    if (!(passwordInput instanceof HTMLInputElement)) return;
    const password = passwordInput.value;
    if (!password || password.length > MAX_PASSWORD) return;
    const usernameInput = usernameInputFor(passwordInput);
    const username =
      usernameInput instanceof HTMLInputElement ? usernameInput.value.slice(0, MAX_USERNAME) : '';
    if (!username) return;
    void invoke('browser_credential_form_submitted', {
      submission: {
        origin: location.origin,
        username,
        password,
      },
    }).catch(() => {});
  };

  document.addEventListener(
    'focusin',
    (event) => {
      if (event.target instanceof HTMLInputElement && event.target.type === 'password') {
        detect(event.target);
      }
    },
    true,
  );
  document.addEventListener(
    'submit',
    (event) => {
      submit(passwordInputFor(event.target));
    },
    true,
  );
  document.addEventListener(
    'click',
    (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const submitControl = target.closest(
        'button[type="submit"],button:not([type]),input[type="submit"]',
      );
      if (submitControl) submit(passwordInputFor(submitControl.closest('form') ?? document));
    },
    true,
  );

  const setInputValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  Object.defineProperty(window, '__ARDOR_BROWSER_CREDENTIALS__', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      fill(payload) {
        if (
          !payload ||
          payload.origin !== location.origin ||
          typeof payload.username !== 'string' ||
          typeof payload.password !== 'string'
        ) {
          return false;
        }
        const passwordInput = passwordInputFor();
        if (!(passwordInput instanceof HTMLInputElement)) return false;
        const usernameInput = usernameInputFor(passwordInput);
        if (usernameInput instanceof HTMLInputElement) {
          setInputValue(usernameInput, payload.username);
        }
        setInputValue(passwordInput, payload.password);
        passwordInput.focus();
        return true;
      },
    }),
  });

  const start = () => {
    detect();
    new MutationObserver(() => detect()).observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
"#;

pub(crate) fn credential_hook_script() -> &'static str {
    CREDENTIAL_HOOK_SCRIPT
}

#[cfg(test)]
mod tests {
    use super::credential_hook_script;

    #[test]
    fn credential_hook_is_https_top_frame_only_and_never_requests_vault_secrets() {
        let script = credential_hook_script();

        assert!(script.contains("window.top !== window"));
        assert!(script.contains("location.protocol !== 'https:'"));
        assert!(script.contains("browser_credential_form_detected"));
        assert!(script.contains("browser_credential_form_submitted"));
        assert!(script.contains("type=\"password\""));
        assert!(!script.contains("get_browser_settings"));
        assert!(!script.contains("get_secret"));
        assert!(!script.contains("list_browser_credentials"));
    }

    #[test]
    fn credential_hook_exposes_fill_only_inside_the_current_document() {
        let script = credential_hook_script();

        assert!(script.contains("__ARDOR_BROWSER_CREDENTIALS__"));
        assert!(script.contains("payload.origin !== location.origin"));
        assert!(script.contains("setInputValue(passwordInput, payload.password)"));
        assert!(script.contains("input.dispatchEvent(new Event('input'"));
        assert!(script.contains("configurable: false"));
    }
}
