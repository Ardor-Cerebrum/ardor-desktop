import { isBrowserNavigableUrl } from "./security";
import type { BrowserSurfacePresentation, SidebarBrowserBounds } from "../bridge-contract";

export const BROWSER_PANE_SESSION_VERSION = 1 as const;

const MAX_CONTEXTS = 256;
const MAX_TABS = 9;
const MAX_CONTEXT_ID_LENGTH = 256;
const MAX_TAB_ID_LENGTH = 256;
const MAX_URL_LENGTH = 32 * 1024;
const MAX_BOUND_COORDINATE = 16_384;
const MAX_MANIFEST_BYTES = 512 * 1024;
const CONTEXT_ID_PATTERN = /^[a-zA-Z0-9:_./-]{1,256}$/;
const TAB_ID_PATTERN = /^[a-zA-Z0-9:_./-]{1,256}$/;
const DEFAULT_PRESENTATION: BrowserSurfacePresentation = "visible";

export interface BrowserPaneSessionTab {
  id: string;
  url: string;
}

export interface BrowserPaneSessionRecord {
  activeTabId: string;
  tabs: BrowserPaneSessionTab[];
  bounds?: SidebarBrowserBounds;
  presentation?: BrowserSurfacePresentation;
}

interface BrowserPaneSessionManifest {
  version: typeof BROWSER_PANE_SESSION_VERSION;
  contexts: Record<string, BrowserPaneSessionRecord>;
}

export interface BrowserPaneSessionStorage {
  read(): string | undefined;
  write(value: string): void;
}

export interface BrowserPaneSessionProtector {
  supported: boolean;
  encrypt(value: string): string;
  decrypt(value: string): string;
}

export interface BrowserPaneSessionStoreOptions {
  storage: BrowserPaneSessionStorage;
  protector: BrowserPaneSessionProtector;
  debounceMs?: number;
}

function emptyManifest(): BrowserPaneSessionManifest {
  return { version: BROWSER_PANE_SESSION_VERSION, contexts: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeUrl(value: string): string | null {
  if (value === "") {
    return "";
  }
  if (value.length > MAX_URL_LENGTH || !isBrowserNavigableUrl(value)) {
    return null;
  }
  return new URL(value).toString();
}

function normalizeBounds(value: unknown): SidebarBrowserBounds | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const bounds = {
    x: Number(value.x),
    y: Number(value.y),
    width: Number(value.width),
    height: Number(value.height),
  };
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    bounds.width < 0 ||
    bounds.height < 0 ||
    bounds.x < 0 ||
    bounds.y < 0 ||
    bounds.x > MAX_BOUND_COORDINATE ||
    bounds.y > MAX_BOUND_COORDINATE ||
    bounds.width > MAX_BOUND_COORDINATE ||
    bounds.height > MAX_BOUND_COORDINATE
  ) {
    return undefined;
  }
  return bounds;
}

function normalizePresentation(value: unknown): BrowserSurfacePresentation | null {
  if (value === "visible" || value === "occluded" || value === "hidden") {
    return value;
  }
  return null;
}

function normalizeRecord(value: unknown): BrowserPaneSessionRecord | null {
  if (!isRecord(value) || typeof value.activeTabId !== "string" || !Array.isArray(value.tabs)) {
    return null;
  }
  const seenIds = new Set<string>();
  const tabs = value.tabs.flatMap((tab) => {
    if (!isRecord(tab) || typeof tab.id !== "string" || typeof tab.url !== "string") {
      return [];
    }
    if (tab.id.length > MAX_TAB_ID_LENGTH || !TAB_ID_PATTERN.test(tab.id)) {
      return [];
    }
    if (seenIds.has(tab.id)) {
      return [];
    }
    seenIds.add(tab.id);
    const url = normalizeUrl(tab.url);
    return url === null ? [] : [{ id: tab.id, url }];
  });
  if (tabs.length === 0 || tabs.length > MAX_TABS) {
    return null;
  }
  const activeTabId = tabs.some((tab) => tab.id === value.activeTabId) ? value.activeTabId : tabs[0].id;
  const bounds = normalizeBounds(value.bounds);
  const presentation = normalizePresentation(value.presentation) ?? DEFAULT_PRESENTATION;
  const result: BrowserPaneSessionRecord = { activeTabId, tabs, presentation };
  if (bounds) {
    result.bounds = bounds;
  }
  return result;
}

function parseManifest(value: unknown): BrowserPaneSessionManifest {
  if (!isRecord(value) || value.version !== BROWSER_PANE_SESSION_VERSION || !isRecord(value.contexts)) {
    return emptyManifest();
  }
  const contexts: Record<string, BrowserPaneSessionRecord> = {};
  for (const [contextId, record] of Object.entries(value.contexts).slice(0, MAX_CONTEXTS)) {
    if (contextId.length > MAX_CONTEXT_ID_LENGTH || !CONTEXT_ID_PATTERN.test(contextId)) {
      continue;
    }
    const normalized = normalizeRecord(record);
    if (normalized) {
      contexts[contextId] = normalized;
    }
  }
  return { version: BROWSER_PANE_SESSION_VERSION, contexts };
}

function cloneRecord(record: BrowserPaneSessionRecord): BrowserPaneSessionRecord {
  const clone: BrowserPaneSessionRecord = {
    activeTabId: record.activeTabId,
    tabs: record.tabs.map((tab) => ({ ...tab })),
    presentation: record.presentation,
  };
  if (record.bounds) {
    clone.bounds = record.bounds;
  }
  return clone;
}

export class BrowserPaneSessionStore {
  private manifest: BrowserPaneSessionManifest;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly debounceMs: number;

  constructor(private readonly options: BrowserPaneSessionStoreOptions) {
    this.debounceMs = Math.max(0, options.debounceMs ?? 250);
    this.manifest = this.readManifest();
  }

  get(contextId: string): BrowserPaneSessionRecord | undefined {
    const record = this.manifest.contexts[contextId];
    return record ? cloneRecord(record) : undefined;
  }

  set(contextId: string, record: BrowserPaneSessionRecord): void {
    if (contextId.length > MAX_CONTEXT_ID_LENGTH || !CONTEXT_ID_PATTERN.test(contextId)) {
      return;
    }
    const normalized = normalizeRecord(record);
    if (!normalized) {
      this.delete(contextId);
      return;
    }
    if (!(contextId in this.manifest.contexts) && Object.keys(this.manifest.contexts).length >= MAX_CONTEXTS) {
      return;
    }
    this.manifest.contexts[contextId] = normalized;
    this.markDirty();
  }

  delete(contextId: string): void {
    if (!(contextId in this.manifest.contexts)) {
      return;
    }
    delete this.manifest.contexts[contextId];
    this.markDirty();
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty || !this.options.protector.supported) {
      return;
    }
    const plaintext = JSON.stringify(this.manifest);
    if (Buffer.byteLength(plaintext, "utf8") > MAX_MANIFEST_BYTES) {
      return;
    }
    try {
      this.options.storage.write(this.options.protector.encrypt(plaintext));
      this.dirty = false;
    } catch {
      // Persistence is best effort; never block the browser UI on keychain or disk errors.
    }
  }

  dispose(): void {
    this.flush();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.timer !== null || this.debounceMs === 0) {
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.debounceMs);
  }

  private readManifest(): BrowserPaneSessionManifest {
    if (!this.options.protector.supported) {
      return emptyManifest();
    }
    let plaintext: string;
    try {
      const encrypted = this.options.storage.read();
      if (!encrypted) {
        return emptyManifest();
      }
      plaintext = this.options.protector.decrypt(encrypted);
    } catch {
      return emptyManifest();
    }
    if (Buffer.byteLength(plaintext, "utf8") > MAX_MANIFEST_BYTES) {
      return emptyManifest();
    }
    try {
      return parseManifest(JSON.parse(plaintext));
    } catch {
      return emptyManifest();
    }
  }
}
