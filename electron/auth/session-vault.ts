import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";

const VAULT_VERSION = 1;
const MAX_VAULT_BYTES = 16_384;
const SESSION_HANDLE_PATTERN = /^[A-Za-z0-9_-]{16,4096}$/;

export interface SessionHandleProtector {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export class DesktopAuthUnavailableError extends Error {
  readonly code = "DESKTOP_AUTH_UNAVAILABLE";

  constructor() {
    super("desktop authentication is unavailable");
    this.name = "DesktopAuthUnavailableError";
  }
}

export class DesktopSessionVault {
  private readonly targetPath: string;

  constructor(filePath: string, private readonly protector: SessionHandleProtector) {
    this.targetPath = resolve(filePath);
  }

  load(): string | null {
    if (!this.protector.isEncryptionAvailable()) {
      this.clear();
      throw new DesktopAuthUnavailableError();
    }
    let persisted: string;
    try {
      persisted = readFileSync(this.targetPath, "utf8");
    } catch {
      return null;
    }

    try {
      if (Buffer.byteLength(persisted, "utf8") > MAX_VAULT_BYTES) {
        throw new Error("invalid vault");
      }
      const parsed = JSON.parse(persisted) as unknown;
      if (!isVaultEnvelope(parsed)) {
        throw new Error("invalid vault");
      }
      const ciphertext = decodeCanonicalBase64(parsed.ciphertext);
      const handle = this.protector.decryptString(ciphertext);
      if (!SESSION_HANDLE_PATTERN.test(handle)) {
        throw new Error("invalid vault");
      }
      return handle;
    } catch {
      this.clear();
      return null;
    }
  }

  save(sessionHandle: string): void {
    if (!this.protector.isEncryptionAvailable()) {
      this.clear();
      throw new DesktopAuthUnavailableError();
    }
    if (!SESSION_HANDLE_PATTERN.test(sessionHandle)) {
      throw new DesktopAuthUnavailableError();
    }

    const ciphertext = this.protector.encryptString(sessionHandle).toString("base64");
    const contents = JSON.stringify({ version: VAULT_VERSION, ciphertext });
    const directory = dirname(this.targetPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.targetPath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.targetPath);
      chmodSync(this.targetPath, 0o600);
    } finally {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The atomic rename succeeded or the temporary file was never created.
      }
    }
  }

  clear(): void {
    try {
      unlinkSync(this.targetPath);
    } catch {
      // Missing or already removed is the desired state.
    }
  }
}

function isVaultEnvelope(value: unknown): value is { version: 1; ciphertext: string } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    record.version === VAULT_VERSION &&
    typeof record.ciphertext === "string"
  );
}

function decodeCanonicalBase64(value: string): Buffer {
  if (!value || value.length > MAX_VAULT_BYTES || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("invalid ciphertext");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new Error("invalid ciphertext");
  }
  return decoded;
}
