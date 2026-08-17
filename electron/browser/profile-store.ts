import type {
  BrowserCredentialMetadata,
  BrowserPreferences,
  BrowserSettingsSnapshot,
} from "../bridge-contract";

export interface BrowserProfileStorage {
  load(): string | undefined;
  save(value: string): void;
}

export interface CredentialProtector {
  supported: boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

interface PersistedCredential extends BrowserCredentialMetadata {
  encryptedPassword: string;
}

interface PersistedProfile {
  preferences: BrowserPreferences;
  credentials: PersistedCredential[];
}

const DEFAULT_PREFERENCES: BrowserPreferences = {
  autofillMode: "ask",
  askToSavePasswords: true,
};

export class BrowserProfileStore {
  private state: PersistedProfile;

  constructor(
    private readonly storage: BrowserProfileStorage,
    private readonly protector: CredentialProtector,
    private readonly now: () => number = Date.now,
  ) {
    this.state = this.readState();
  }

  snapshot(): BrowserSettingsSnapshot {
    return {
      passwordStorageSupported: this.protector.supported,
      preferences: { ...this.state.preferences },
      credentials: this.state.credentials.map(({ encryptedPassword: _encryptedPassword, ...metadata }) => ({ ...metadata })),
      downloads: [],
    };
  }

  updatePreferences(preferences: BrowserPreferences): BrowserSettingsSnapshot {
    this.state.preferences = { ...preferences };
    this.persist();
    return this.snapshot();
  }

  saveCredential(input: { origin: string; username: string; password: string }): BrowserCredentialMetadata {
    if (!this.protector.supported) {
      throw new Error("secure credential storage is unavailable");
    }
    const now = Math.floor(this.now() / 1000);
    const existing = this.state.credentials.find(
      (credential) => credential.origin === input.origin && credential.username === input.username,
    );
    const credential: PersistedCredential = {
      id: existing?.id ?? crypto.randomUUID(),
      origin: input.origin,
      username: input.username,
      encryptedPassword: this.protector.encrypt(input.password),
      createdAtUnixSeconds: existing?.createdAtUnixSeconds ?? now,
      updatedAtUnixSeconds: now,
    };
    this.state.credentials = existing
      ? this.state.credentials.map((item) => (item.id === existing.id ? credential : item))
      : [...this.state.credentials, credential];
    this.persist();
    return this.metadata(credential);
  }

  getCredential(id: string): { origin: string; username: string; password: string } | null {
    const credential = this.state.credentials.find((item) => item.id === id);
    if (!credential || !this.protector.supported) {
      return null;
    }
    return {
      origin: credential.origin,
      username: credential.username,
      password: this.protector.decrypt(credential.encryptedPassword),
    };
  }

  deleteCredential(id: string): boolean {
    const next = this.state.credentials.filter((credential) => credential.id !== id);
    if (next.length === this.state.credentials.length) {
      return false;
    }
    this.state.credentials = next;
    this.persist();
    return true;
  }

  private metadata(credential: PersistedCredential): BrowserCredentialMetadata {
    const { encryptedPassword: _encryptedPassword, ...metadata } = credential;
    return metadata;
  }

  private readState(): PersistedProfile {
    const raw = this.storage.load();
    if (!raw) {
      return { preferences: { ...DEFAULT_PREFERENCES }, credentials: [] };
    }
    try {
      const parsed = JSON.parse(raw) as Partial<PersistedProfile>;
      const preferences = parsed.preferences;
      const credentials = parsed.credentials;
      if (!preferences || !Array.isArray(credentials)) {
        throw new Error("invalid browser profile");
      }
      return {
        preferences: {
          autofillMode: preferences.autofillMode === "automatic" ? "automatic" : "ask",
          askToSavePasswords: preferences.askToSavePasswords !== false,
        },
        credentials: credentials.filter((credential): credential is PersistedCredential =>
          Boolean(
            credential &&
              typeof credential.id === "string" &&
              typeof credential.origin === "string" &&
              typeof credential.username === "string" &&
              typeof credential.encryptedPassword === "string" &&
              typeof credential.createdAtUnixSeconds === "number" &&
              typeof credential.updatedAtUnixSeconds === "number",
          ),
        ),
      };
    } catch {
      return { preferences: { ...DEFAULT_PREFERENCES }, credentials: [] };
    }
  }

  private persist(): void {
    this.storage.save(JSON.stringify(this.state));
  }
}
