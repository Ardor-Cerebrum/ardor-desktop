import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Session } from "electron";

import { configureBrowserWebAuthn, installSoleWebAuthnAccountSelection } from "./webauthn-account-selection";

type AccountSelectionListener = (
  event: Electron.Event,
  details: Electron.SelectWebauthnAccountDetails,
  callback: (credentialId?: string | null) => void,
) => void;

function createSession() {
  let listener: AccountSelectionListener | undefined;
  const removeAllListeners = mock((event: string) => {
    if (event === "select-webauthn-account") listener = undefined;
  });
  const on = mock((event: string, nextListener: AccountSelectionListener) => {
    if (event === "select-webauthn-account") listener = nextListener;
  });
  return {
    getListener: () => listener,
    on,
    removeAllListeners,
    session: { on, removeAllListeners } as unknown as Session,
  };
}

function selectionDetails(
  accounts: Electron.WebAuthnAccount[],
): Electron.SelectWebauthnAccountDetails {
  return { accounts, frame: null, relyingPartyId: "example.com" };
}

const originalWarn = console.warn;

afterEach(() => {
  console.warn = originalWarn;
});

describe("WebAuthn account selection", () => {
  test("selects the sole discoverable account", () => {
    const fixture = createSession();
    const callback = mock(() => undefined);
    console.warn = mock(() => undefined);

    installSoleWebAuthnAccountSelection(fixture.session);
    fixture.getListener()?.({} as Electron.Event, selectionDetails([{ credentialId: "credential-1" }]), callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith("credential-1");
    expect(console.warn).not.toHaveBeenCalled();
  });

  test.each([
    ["zero", []],
    ["multiple", [{ credentialId: "credential-1" }, { credentialId: "credential-2" }]],
  ])("cancels selection with %s discoverable accounts", (_label, accounts) => {
    const fixture = createSession();
    const callback = mock(() => undefined);
    console.warn = mock(() => undefined);

    installSoleWebAuthnAccountSelection(fixture.session);
    fixture.getListener()?.({} as Electron.Event, selectionDetails(accounts), callback);

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(undefined);
    expect(console.warn).toHaveBeenCalledWith(
      "[webauthn] %d discoverable credentials for rpId=%s; no picker UI — cancelling",
      accounts.length,
      "example.com",
    );
  });

  test("replaces an existing account-selection listener", () => {
    const fixture = createSession();
    const previousListener = mock(() => undefined);
    fixture.on("select-webauthn-account", previousListener);

    installSoleWebAuthnAccountSelection(fixture.session);
    const firstInstalledListener = fixture.getListener();
    installSoleWebAuthnAccountSelection(fixture.session);

    expect(fixture.removeAllListeners).toHaveBeenCalledTimes(2);
    expect(fixture.removeAllListeners).toHaveBeenCalledWith("select-webauthn-account");
    expect(fixture.on).toHaveBeenCalledTimes(3);
    expect(fixture.getListener()).toBeDefined();
    expect(fixture.getListener()).not.toBe(previousListener);
    expect(fixture.getListener()).not.toBe(firstInstalledListener);
  });

  test("configures Touch ID and installs selection on the default session", () => {
    const fixture = createSession();
    const configureWebAuthn = mock(() => undefined);

    configureBrowserWebAuthn({ configureWebAuthn } as never, fixture.session, "darwin");

    expect(configureWebAuthn).toHaveBeenCalledWith({
      touchID: { keychainAccessGroup: "com.ardor.desktop.browser.webauthn" },
    });
    expect(fixture.removeAllListeners).toHaveBeenCalledWith("select-webauthn-account");
    expect(fixture.getListener()).toBeDefined();
  });
});
