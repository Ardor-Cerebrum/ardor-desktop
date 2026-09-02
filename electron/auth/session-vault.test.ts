import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DesktopAuthUnavailableError, DesktopSessionVault } from "./session-vault";

const temporaryDirectories: string[] = [];

function temporaryVaultPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "ardor-session-vault-"));
  temporaryDirectories.push(directory);
  return join(directory, "identity-session.json");
}

function protector(available = true) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from(`protected:${value}`, "utf8"),
    decryptString: (value: Buffer) => {
      const decoded = value.toString("utf8");
      if (!decoded.startsWith("protected:")) throw new Error("keychain rejected ciphertext");
      return decoded.slice("protected:".length);
    },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DesktopSessionVault", () => {
  test("persists only a versioned safeStorage ciphertext and replaces it atomically", () => {
    const path = temporaryVaultPath();
    const vault = new DesktopSessionVault(path, protector());

    vault.save("opaque-session-handle-one-1234567890");
    const firstFile = readFileSync(path, "utf8");
    expect(firstFile).not.toContain("opaque-session-handle-one");
    expect(JSON.parse(firstFile)).toEqual({
      version: 1,
      ciphertext: Buffer.from("protected:opaque-session-handle-one-1234567890").toString("base64"),
    });
    expect(vault.load()).toBe("opaque-session-handle-one-1234567890");

    vault.save("opaque-session-handle-two-1234567890");
    expect(vault.load()).toBe("opaque-session-handle-two-1234567890");
  });

  test.each([
    ["plaintext legacy", "opaque-session-handle-one-1234567890"],
    ["corrupt JSON", "{"],
    ["wrong version", JSON.stringify({ version: 2, ciphertext: "cHJvdGVjdGVkOmFiYw==" })],
    ["invalid ciphertext", JSON.stringify({ version: 1, ciphertext: "not base64!" })],
  ])("fails closed and clears %s vault data", (_name, contents) => {
    const path = temporaryVaultPath();
    writeFileSync(path, contents);
    const vault = new DesktopSessionVault(path, protector());

    expect(vault.load()).toBeNull();
    expect(() => readFileSync(path)).toThrow();
  });

  test("clears persisted state and returns a recoverable error when safeStorage is unavailable", () => {
    const path = temporaryVaultPath();
    writeFileSync(path, JSON.stringify({ version: 1, ciphertext: "cHJvdGVjdGVkOmFiYw==" }));
    const vault = new DesktopSessionVault(path, protector(false));

    expect(() => vault.load()).toThrow(DesktopAuthUnavailableError);
    expect(() => readFileSync(path)).toThrow();
    expect(() => vault.save("opaque-session-handle-one-1234567890")).toThrow(
      DesktopAuthUnavailableError,
    );
  });

  test("reports unavailable safeStorage even when no prior vault exists", () => {
    const vault = new DesktopSessionVault(temporaryVaultPath(), protector(false));
    expect(() => vault.load()).toThrow(DesktopAuthUnavailableError);
  });
});
