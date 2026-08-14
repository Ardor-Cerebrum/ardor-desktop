import type { Session } from "electron";

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
