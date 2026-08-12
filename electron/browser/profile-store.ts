import type {
  BrowserCredentialMetadata,
  BrowserPreferences,
  BrowserSettingsSnapshot,
  BrowserStorageMode,
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
  storageMode: BrowserStorageMode;
  trackedPartitions: string[];
}

const DEFAULT_PREFERENCES: BrowserPreferences = {
  autofillMode: "ask",
  askToSavePasswords: true,
};
const DEFAULT_STORAGE_MODE: BrowserStorageMode = "shared";
const MAX_TRACKED_PARTITIONS = 512;
const PARTITION_PATTERN = /^(?:persist:)?ardor-browser(?:-(?:session-)?[a-f0-9]{12})?$/;

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
      storageMode: this.state.storageMode,
      preferences: { ...this.state.preferences },
      credentials: this.state.credentials.map(({ encryptedPassword: _encryptedPassword, ...metadata }) => ({ ...metadata })),
      downloads: [],
    };
  }

  updateStorageMode(storageMode: BrowserStorageMode): BrowserSettingsSnapshot {
    this.state.storageMode = storageMode;
    this.persist();
    return this.snapshot();
  }

  trackedPartitions(): string[] {
    return [...this.state.trackedPartitions];
  }

  trackPartition(partition: string): void {
    if (
      !PARTITION_PATTERN.test(partition) ||
      this.state.trackedPartitions.includes(partition) ||
      this.state.trackedPartitions.length >= MAX_TRACKED_PARTITIONS
    ) {
      return;
    }
    this.state.trackedPartitions.push(partition);
    this.persist();
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
      return {
        preferences: { ...DEFAULT_PREFERENCES },
        credentials: [],
        storageMode: DEFAULT_STORAGE_MODE,
        trackedPartitions: [],
      };
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
        storageMode:
          parsed.storageMode === "none" || parsed.storageMode === "session"
            ? parsed.storageMode
            : DEFAULT_STORAGE_MODE,
        trackedPartitions: Array.isArray(parsed.trackedPartitions)
          ? parsed.trackedPartitions
              .filter((partition): partition is string =>
                typeof partition === "string" && PARTITION_PATTERN.test(partition),
              )
              .slice(0, MAX_TRACKED_PARTITIONS)
          : [],
      };
    } catch {
      return {
        preferences: { ...DEFAULT_PREFERENCES },
        credentials: [],
        storageMode: DEFAULT_STORAGE_MODE,
        trackedPartitions: [],
      };
    }
  }

  private persist(): void {
    this.storage.save(JSON.stringify(this.state));
  }
}
