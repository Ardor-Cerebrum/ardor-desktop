import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { DesktopAccountNamespaces, parseVerifiedDesktopScope } from "./account-namespace.js";

const scope = { accountId: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const proof = (generation = 0, aliases = ["google-oauth2|A"]) => parseVerifiedDesktopScope({ version: 2,
  account_id: scope.accountId, workspace_id: scope.workspaceId, credential_generation: generation,
  legacy_account_ids: aliases, expires_at: Math.floor(Date.now() / 1000) + 60 }, scope);
const home = (root: string, account: string) => join(root, "local-cerebrum", "stage1", hash(account), hash(scope.workspaceId));

describe("verified stable account namespace", () => {
  test.each(["{", '{"version":99}', "null", "[]"])("preserves unsupported or interrupted manifest %s", (contents) => {
    const root = mkdtempSync(join(tmpdir(), "ardor-namespace-invalid-"));
    try {
      const store = new DesktopAccountNamespaces({ userDataPath: root, channel: "stage1" });
      store.register(proof());
      const path = join(root, "local-cerebrum", "stage1", "account-namespaces", hash(scope.accountId), `${hash(scope.workspaceId)}.json`);
      writeFileSync(path, contents);
      const restarted = new DesktopAccountNamespaces({ userDataPath: root, channel: "stage1" });
      expect(() => restarted.register(proof(1))).toThrow();
      expect(readFileSync(path, "utf8")).toBe(contents);
      expect(() => restarted.dataHome(scope)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("isolates account and workspace histories and ignores an incomplete temporary write", () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-namespace-isolation-"));
    try {
      const store = new DesktopAccountNamespaces({ userDataPath: root, channel: "stage1" });
      store.register(proof());
      const first = store.dataHome(scope);
      const manifest = join(root, "local-cerebrum", "stage1", "account-namespaces", hash(scope.accountId), `${hash(scope.workspaceId)}.json`);
      writeFileSync(`${manifest}.interrupted.tmp`, "{");
      for (const other of [
        { ...scope, accountId: "33333333-3333-4333-8333-333333333333" },
        { ...scope, workspaceId: "44444444-4444-4444-8444-444444444444" },
      ]) {
        expect(() => store.dataHome(other)).toThrow();
        store.register({ ...proof(), ...other, legacyAccountIds: [] });
        expect(store.dataHome(other)).not.toBe(first);
      }
      const restarted = new DesktopAccountNamespaces({ userDataPath: root, channel: "stage1" });
      restarted.register(proof());
      expect(restarted.dataHome(scope)).toBe(first);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("fresh storage uses stable UUID and an on-disk mapping never grants authority by itself", () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-namespace-fresh-"));
    try {
      const store = new DesktopAccountNamespaces({ userDataPath: root, channel: "stage1" });
      expect(() => store.dataHome(scope)).toThrow();
      store.register(proof());
      expect(store.dataHome(scope)).toBe(home(root, scope.accountId));
      const restarted = new DesktopAccountNamespaces({ userDataPath: root, channel: "stage1" });
      expect(() => restarted.dataHome(scope)).toThrow();
      restarted.register(proof(1));
      expect(restarted.dataHome(scope)).toBe(home(root, scope.accountId));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("Google A to GitHub B retains the exact old local data without moving files", () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-namespace-upgrade-"));
    try {
      const legacy = home(root, "google-oauth2|A");
      mkdirSync(legacy, { recursive: true });
      writeFileSync(join(legacy, "history.sqlite"), "retained-history");
      const store = new DesktopAccountNamespaces({ userDataPath: root, channel: "stage1" });
      store.register(proof(0));
      expect(store.dataHome(scope)).toBe(legacy);
      const runtimeId = `local-${hash(`stage1:${hash("google-oauth2|A")}:${hash(scope.workspaceId)}`)}`;
      expect(store.runtimeId(scope)).toBe(runtimeId);
      const restarted = new DesktopAccountNamespaces({ userDataPath: root, channel: "stage1" });
      restarted.register(proof(7, ["google-oauth2|A", "github|B"]));
      expect(restarted.dataHome(scope)).toBe(legacy);
      expect(restarted.runtimeId(scope)).toBe(runtimeId);
      expect(readFileSync(join(legacy, "history.sqlite"), "utf8")).toBe("retained-history");
      expect(existsSync(home(root, scope.accountId))).toBe(false);
      expect(() => restarted.register(proof(6))).toThrow();
      restarted.clear(scope.accountId);
      expect(() => restarted.dataHome(scope)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("conflicting canonical and legacy histories are preserved and never auto-merged", () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-namespace-conflict-"));
    try {
      for (const account of [scope.accountId, "google-oauth2|A"]) {
        mkdirSync(home(root, account), { recursive: true });
        writeFileSync(join(home(root, account), "history.sqlite"), account);
      }
      const store = new DesktopAccountNamespaces({ userDataPath: root, channel: "stage1" });
      expect(() => store.register(proof())).toThrow();
      for (const account of [scope.accountId, "google-oauth2|A"]) {
        expect(readFileSync(join(home(root, account), "history.sqlite"), "utf8")).toBe(account);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a forged manifest cannot select an alias the current server did not verify", () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-namespace-forged-"));
    try {
      const store = new DesktopAccountNamespaces({ userDataPath: root, channel: "stage1" });
      store.register(proof());
      const path = join(root, "local-cerebrum", "stage1", "account-namespaces", hash(scope.accountId), `${hash(scope.workspaceId)}.json`);
      const original = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify({ ...original, storageAccountHash: hash("unrelated-owner") }));
      const restarted = new DesktopAccountNamespaces({ userDataPath: root, channel: "stage1" });
      expect(() => restarted.register(proof())).toThrow();
      expect(() => restarted.dataHome(scope)).toThrow();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("a junction cannot redirect a verified alias into another directory", () => {
    const root = mkdtempSync(join(tmpdir(), "ardor-namespace-junction-"));
    try {
      const outside = join(root, "other-owner");
      mkdirSync(outside);
      const account = join(root, "local-cerebrum", "stage1", hash("google-oauth2|A"));
      mkdirSync(join(root, "local-cerebrum", "stage1"), { recursive: true });
      symlinkSync(outside, account, "junction");
      const store = new DesktopAccountNamespaces({ userDataPath: root, channel: "stage1" });
      expect(() => store.register(proof())).toThrow();
      expect(existsSync(outside)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test.each([undefined, null, true, -1, 0.5, "0", Number.MAX_SAFE_INTEGER + 1])("rejects invalid original generation %s", (generation) => {
    expect(() => parseVerifiedDesktopScope({ version: 2, account_id: scope.accountId, workspace_id: scope.workspaceId,
      credential_generation: generation, legacy_account_ids: [], expires_at: Math.floor(Date.now() / 1000) + 60 }, scope)).toThrow();
  });
});
