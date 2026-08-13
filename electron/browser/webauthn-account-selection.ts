import type { App, Session } from "electron";

const BROWSER_WEBAUTHN_KEYCHAIN_ACCESS_GROUP = "com.ardor.desktop.browser.webauthn";

export function installSoleWebAuthnAccountSelection(browserSession: Session): void {
  browserSession.removeAllListeners("select-webauthn-account");
  browserSession.on("select-webauthn-account", (_event, details, callback) => {
    const { accounts, relyingPartyId } = details;
    let credentialId: string | undefined;
    try {
      if (accounts.length === 1) {
        credentialId = accounts[0]?.credentialId;
      } else {
        console.warn(
          "[webauthn] %d discoverable credentials for rpId=%s; no picker UI — cancelling",
          accounts.length,
          relyingPartyId,
        );
      }
    } finally {
      callback(credentialId);
    }
  });
}

export function configureBrowserWebAuthn(
  application: Pick<App, "configureWebAuthn">,
  defaultBrowserSession: Session,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "darwin" && typeof application.configureWebAuthn === "function") {
    application.configureWebAuthn({
      touchID: {
        keychainAccessGroup: BROWSER_WEBAUTHN_KEYCHAIN_ACCESS_GROUP,
      },
    });
  }
  installSoleWebAuthnAccountSelection(defaultBrowserSession);
}
