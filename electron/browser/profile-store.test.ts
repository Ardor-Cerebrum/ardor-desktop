import { describe, expect, test } from "bun:test";

import { BrowserProfileStore, type BrowserProfileStorage, type CredentialProtector } from "./profile-store";

const createMemoryStorage = (): BrowserProfileStorage & { value?: string } => ({
  value: undefined,
  load() {
    return this.value;
  },
  save(value) {
    this.value = value;
  },
});

const protector: CredentialProtector = {
  supported: true,
  encrypt: (value) => `encrypted:${value}`,
  decrypt: (value) => value.replace("encrypted:", ""),
};

describe("BrowserProfileStore", () => {
  test("persists preferences and keeps credential secrets out of snapshots", () => {
    const storage = createMemoryStorage();
    const store = new BrowserProfileStore(storage, protector, () => 1_000);
    store.updatePreferences({ autofillMode: "automatic", askToSavePasswords: false });
    const credential = store.saveCredential({ origin: "https://example.com", username: "alice", password: "secret" });

    expect(credential.username).toBe("alice");
    expect(store.snapshot().preferences).toEqual({ autofillMode: "automatic", askToSavePasswords: false });
    expect(store.snapshot().storageMode).toBe("shared");
    expect(store.snapshot().credentials).toEqual([credential]);
    expect(storage.value).toContain("encrypted:secret");
    expect(JSON.stringify(store.snapshot())).not.toContain("secret");

    const restored = new BrowserProfileStore(storage, protector, () => 2_000);
    expect(restored.getCredential(credential.id)).toEqual({
      origin: "https://example.com",
      username: "alice",
      password: "secret",
    });
  });

  test("persists the Browser storage mode and bounded partition registry", () => {
    const storage = createMemoryStorage();
    const store = new BrowserProfileStore(storage, protector);

    store.updateStorageMode("session");
    store.trackPartition("persist:ardor-browser-session-0123456789ab");
    store.trackPartition("persist:ardor-browser-session-0123456789ab");
    store.trackPartition("persist:not-a-browser-profile");

    const restored = new BrowserProfileStore(storage, protector);
    expect(restored.snapshot().storageMode).toBe("session");
    expect(restored.trackedPartitions()).toEqual(["persist:ardor-browser-session-0123456789ab"]);
  });

  test("deletes a credential by opaque id", () => {
    const store = new BrowserProfileStore(createMemoryStorage(), protector, () => 1_000);
    const credential = store.saveCredential({ origin: "https://example.com", username: "alice", password: "secret" });
    expect(store.deleteCredential(credential.id)).toBe(true);
    expect(store.deleteCredential(credential.id)).toBe(false);
    expect(store.snapshot().credentials).toEqual([]);
  });
});
