import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";
import type { LocalAgentRuntimeScope } from "./protocol.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{32}$/;
const FAILURE = "Local account history could not be safely verified.";

export interface VerifiedDesktopScope extends LocalAgentRuntimeScope {
  readonly credentialGeneration: number;
  readonly legacyAccountIds: readonly string[];
  readonly expiresAt: number;
}

interface NamespaceRecord {
  readonly version: 1;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly storageAccountHash: string;
  readonly credentialGeneration: number;
}

export class DesktopAccountNamespaces {
  private readonly anchor: string;
  private readonly root: string;
  private readonly channel: string;
  private readonly bindings = new Map<string, string>();

  constructor(options: { userDataPath: string; channel: string }) {
    if (!/^[a-z0-9-]{1,32}$/.test(options.channel)) throw new Error(FAILURE);
    this.anchor = resolve(options.userDataPath);
    this.channel = options.channel;
    this.root = resolve(this.anchor, "local-cerebrum", options.channel);
  }

  register(authority: VerifiedDesktopScope): void {
    if (authority.expiresAt * 1000 <= Date.now()) throw new Error(FAILURE);
    const workspaceHash = hashScopePart(authority.workspaceId);
    const canonicalHash = hashScopePart(authority.accountId);
    const allowed = new Set([canonicalHash, ...authority.legacyAccountIds.map(hashScopePart)]);
    const manifest = resolve(this.root, "account-namespaces", canonicalHash, `${workspaceHash}.json`);
    this.assertNoLinks(manifest);
    const previous = existsSync(manifest) ? readRecord(manifest) : null;
    if (previous && (previous.accountId !== authority.accountId || previous.workspaceId !== authority.workspaceId ||
        !allowed.has(previous.storageAccountHash) || previous.credentialGeneration > authority.credentialGeneration)) {
      throw new Error(FAILURE);
    }
    const selectedHash = previous?.storageAccountHash ?? this.selectExistingHome(allowed, workspaceHash, canonicalHash);
    const dataHome = resolve(this.root, selectedHash, workspaceHash);
    this.assertNoLinks(dataHome);
    // SECURITY(ARD-2909): a verified alias selects existing data in place. Never
    // rename/merge user directories or treat this local mapping as login proof.
    if (!previous || previous.credentialGeneration !== authority.credentialGeneration) {
      this.writeRecord(manifest, { version: 1, accountId: authority.accountId, workspaceId: authority.workspaceId,
        storageAccountHash: selectedHash, credentialGeneration: authority.credentialGeneration });
    }
    this.bindings.set(scopeKey(authority), dataHome);
  }

  dataHome(scope: LocalAgentRuntimeScope): string {
    const path = this.bindings.get(scopeKey(scope));
    if (!path) throw new Error(FAILURE);
    this.assertNoLinks(path);
    return path;
  }

  runtimeId(scope: LocalAgentRuntimeScope): string {
    // NOTE(ARD-2909): routes and history caches already contain this identifier.
    // Retain the original namespace's ID while account authorization uses UUID.
    const accountHash = basename(dirname(this.dataHome(scope)));
    return `local-${hashScopePart(`${this.channel}:${accountHash}:${hashScopePart(scope.workspaceId)}`)}`;
  }

  clear(accountId?: string): void {
    if (accountId === undefined) { this.bindings.clear(); return; }
    for (const key of this.bindings.keys()) {
      const scope: unknown = JSON.parse(key);
      if (Array.isArray(scope) && scope[0] === accountId) this.bindings.delete(key);
    }
  }

  private selectExistingHome(allowed: ReadonlySet<string>, workspaceHash: string, canonicalHash: string): string {
    let selected: string | undefined;
    for (const accountHash of allowed) {
      const path = resolve(this.root, accountHash, workspaceHash);
      this.assertNoLinks(path);
      if (!existsSync(path)) continue;
      if (!lstatSync(path).isDirectory() || selected !== undefined) throw new Error(FAILURE);
      selected = accountHash;
    }
    return selected ?? canonicalHash;
  }

  private assertNoLinks(path: string): void {
    const child = relative(this.anchor, path);
    if (child === ".." || child.startsWith(`..${sep}`) || resolve(this.anchor, child) !== path) throw new Error(FAILURE);
    let current = this.anchor;
    for (const part of ["", ...child.split(sep)]) {
      if (part) current = resolve(current, part);
      if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(FAILURE);
    }
  }

  private writeRecord(path: string, record: NamespaceRecord): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.assertNoLinks(path);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* Preserve the original write failure. */ }
      throw error;
    }
  }
}

export function parseVerifiedDesktopScope(value: unknown, expected: LocalAgentRuntimeScope): VerifiedDesktopScope {
  if (!isRecord(value) || value.version !== 2 || value.account_id !== expected.accountId ||
      value.workspace_id !== expected.workspaceId || !UUID_PATTERN.test(expected.accountId) ||
      !UUID_PATTERN.test(expected.workspaceId) || !validGeneration(value.credential_generation) ||
      typeof value.expires_at !== "number" || !Number.isSafeInteger(value.expires_at) ||
      value.expires_at * 1000 <= Date.now() || !Array.isArray(value.legacy_account_ids) || value.legacy_account_ids.length > 256) {
    throw new Error(FAILURE);
  }
  const aliases: string[] = [];
  for (const alias of value.legacy_account_ids) {
    if (typeof alias !== "string" || !/^\S{1,255}$/.test(alias) || aliases.includes(alias)) throw new Error(FAILURE);
    aliases.push(alias);
  }
  return { ...expected, credentialGeneration: value.credential_generation, legacyAccountIds: aliases, expiresAt: value.expires_at };
}

function readRecord(path: string): NamespaceRecord {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  let value: unknown;
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size > 4096) throw new Error(FAILURE);
    const bytes = Buffer.alloc(4097);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > 4096) throw new Error(FAILURE);
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
  } finally { closeSync(descriptor); }
  if (!isRecord(value) || value.version !== 1 || typeof value.accountId !== "string" ||
      typeof value.workspaceId !== "string" || typeof value.storageAccountHash !== "string" ||
      !HASH_PATTERN.test(value.storageAccountHash) || !validGeneration(value.credentialGeneration)) throw new Error(FAILURE);
  return { version: 1, accountId: value.accountId, workspaceId: value.workspaceId,
    storageAccountHash: value.storageAccountHash, credentialGeneration: value.credentialGeneration };
}

function validGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashScopePart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function scopeKey(scope: LocalAgentRuntimeScope): string {
  return JSON.stringify([scope.accountId, scope.workspaceId]);
}
