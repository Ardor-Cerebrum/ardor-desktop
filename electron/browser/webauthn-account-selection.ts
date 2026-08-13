import type { App, Session } from "electron";

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
  keychainAccessGroup?: string,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "darwin" && keychainAccessGroup && typeof application.configureWebAuthn === "function") {
    application.configureWebAuthn({
      touchID: {
        keychainAccessGroup,
      },
    });
  }
  installSoleWebAuthnAccountSelection(defaultBrowserSession);
}
