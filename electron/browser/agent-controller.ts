import type { BrowserAgentCommand, BrowserAgentExecutionResult } from "../bridge-contract";
import { clickBrowserPageElement, typeIntoBrowserPageElement } from "./agent-page-actions";
import { readBrowserPage } from "./agent-read-page";
import type { BrowserAgentTabTarget, BrowserPaneController } from "./pane-controller";
import { normalizeBrowserNavigationUrl } from "./security";

const ID_PATTERN = /^[a-zA-Z0-9:_./-]{1,256}$/;
const REF_PATTERN = /^ref_[1-9][0-9]{0,7}$/;
const MAX_TYPE_TEXT_BYTES = 16 * 1024;

interface BrowserAgentBinding {
  activeContextId: string;
  contextIds: string[];
  grantedOrigins: Set<string>;
}

interface BoundBrowserAgentTarget extends BrowserAgentTabTarget {
  contextId: string;
}

export interface BrowserAgentControllerOptions {
  authorizeOrigin: (input: { origin: string; sessionId: string; tool: string }) => Promise<boolean>;
}

function browserOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export class BrowserAgentController {
  private readonly bindings = new Map<string, BrowserAgentBinding>();

  constructor(
    private readonly panes: BrowserPaneController,
    private readonly options: BrowserAgentControllerOptions,
  ) {}

  bind(sessionId: string, contextId: string): boolean {
    this.assertId(sessionId, "session");
    this.assertId(contextId, "context");
    const existing = this.bindings.get(sessionId);
    if (existing) {
      if (!existing.contextIds.includes(contextId)) existing.contextIds.push(contextId);
      existing.activeContextId = contextId;
      return true;
    }
    this.bindings.set(sessionId, {
      activeContextId: contextId,
      contextIds: [contextId],
      grantedOrigins: new Set(),
    });
    return true;
  }

  unbind(sessionId: string, contextId: string): boolean {
    this.assertId(sessionId, "session");
    this.assertId(contextId, "context");
    const binding = this.bindings.get(sessionId);
    if (!binding || !binding.contextIds.includes(contextId)) return false;
    binding.contextIds = binding.contextIds.filter((candidate) => candidate !== contextId);
    if (binding.contextIds.length === 0) {
      this.bindings.delete(sessionId);
    } else if (binding.activeContextId === contextId) {
      binding.activeContextId = binding.contextIds.at(-1) as string;
    }
    return true;
  }

  async execute(sessionId: string, command: BrowserAgentCommand): Promise<BrowserAgentExecutionResult> {
    try {
      this.assertId(sessionId, "session");
      const binding = this.bindings.get(sessionId);
      if (!binding) throw new Error("No Browser tile is attached to this chat session");
      switch (command.name) {
        case "tabs_context":
          return { ok: true, result: this.tabsContext(binding) };
        case "read_page":
          return { ok: true, result: await this.readPage(sessionId, binding, command.input?.tabId) };
        case "navigate":
          return { ok: true, result: await this.navigate(sessionId, binding, command.input) };
        case "click":
          return { ok: true, result: await this.click(sessionId, binding, command.input) };
        case "type":
          return { ok: true, result: await this.type(sessionId, binding, command.input) };
        default:
          throw new Error("Browser agent command is not supported");
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Browser agent command failed" };
    }
  }

  dispose(): void {
    this.bindings.clear();
  }

  private tabsContext(binding: BrowserAgentBinding): Record<string, unknown> {
    const snapshots = binding.contextIds.flatMap((contextId) => {
      const snapshot = this.panes.getState(contextId);
      return snapshot ? [snapshot] : [];
    });
    if (snapshots.length === 0) throw new Error("The attached Browser tiles are unavailable");
    const activeSnapshot = snapshots.find((snapshot) => snapshot?.contextId === binding.activeContextId) ?? snapshots[0];
    return {
      activeTabId: activeSnapshot.activeTabId,
      tabs: snapshots.flatMap(
        (snapshot) =>
          snapshot?.tabs.map((tab) => ({
            active: snapshot.contextId === activeSnapshot.contextId && tab.active,
            contextId: snapshot.contextId,
            id: tab.id,
            loading: tab.loading,
            origin: browserOrigin(tab.url),
            title: tab.title,
            url: tab.url,
          })) ?? [],
      ),
    };
  }

  private async readPage(
    sessionId: string,
    binding: BrowserAgentBinding,
    requestedTabId: unknown,
  ): Promise<Record<string, unknown>> {
    const target = this.resolveTarget(binding, requestedTabId);
    const origin = browserOrigin(target.url);
    if (!origin) throw new Error("The selected Browser tab does not have a readable web origin");
    await this.ensureOriginAccess(sessionId, binding, origin, "read_page", target);

    const page = await readBrowserPage(target.handle);
    const current = this.panes.resolveAgentTab(target.contextId, target.id);
    if (current.navigationEpoch !== target.navigationEpoch || browserOrigin(current.url) !== origin) {
      throw new Error("The Browser page navigated while it was being read; call read_page again");
    }
    return {
      ...page,
      navigationEpoch: target.navigationEpoch,
      origin,
      tabId: target.id,
    };
  }

  private async navigate(
    sessionId: string,
    binding: BrowserAgentBinding,
    input: { tabId?: string | null; url: string },
  ): Promise<Record<string, unknown>> {
    if (!input || typeof input.url !== "string") throw new Error("Browser navigation URL is invalid");
    const target = this.resolveTarget(binding, input.tabId);
    const normalizedUrl = normalizeBrowserNavigationUrl(input.url);
    if (!normalizedUrl) throw new Error("Browser navigation URL must be public HTTPS or loopback HTTP(S)");
    const destinationOrigin = browserOrigin(normalizedUrl);
    if (!destinationOrigin) throw new Error("Browser navigation URL must be public HTTPS or loopback HTTP(S)");
    await this.ensureOriginAccess(sessionId, binding, destinationOrigin, "navigate", target);
    const snapshot = await this.panes.navigateAgentTab(target.contextId, target.id, normalizedUrl);
    const current = this.panes.resolveAgentTab(target.contextId, target.id);
    return {
      finalOrigin: browserOrigin(current.url),
      tabId: current.id,
      url: current.url,
      activeTabId: snapshot.activeTabId,
    };
  }

  private async click(
    sessionId: string,
    binding: BrowserAgentBinding,
    input: { ref: string; tabId?: string | null },
  ): Promise<Record<string, unknown>> {
    const target = this.resolveActionTarget(binding, input);
    const origin = this.requireTargetOrigin(target.url);
    await this.ensureOriginAccess(sessionId, binding, origin, "click", target);
    await clickBrowserPageElement(target.handle, input.ref, () =>
      this.assertTargetStable(binding, target, origin, "prepared for clicking"),
    );
    return { clicked: input.ref, navigationEpoch: target.navigationEpoch, origin, tabId: target.id };
  }

  private async type(
    sessionId: string,
    binding: BrowserAgentBinding,
    input: { ref: string; text: string; submit?: boolean; tabId?: string | null },
  ): Promise<Record<string, unknown>> {
    const target = this.resolveActionTarget(binding, input);
    if (typeof input.text !== "string" || new TextEncoder().encode(input.text).byteLength > MAX_TYPE_TEXT_BYTES) {
      throw new Error("Browser type text is invalid or too large");
    }
    if (input.submit !== undefined && typeof input.submit !== "boolean") {
      throw new Error("Browser type submit flag is invalid");
    }
    const origin = this.requireTargetOrigin(target.url);
    await this.ensureOriginAccess(sessionId, binding, origin, "type", target);
    await typeIntoBrowserPageElement(target.handle, input.ref, input.text, input.submit === true, () =>
      this.assertTargetStable(binding, target, origin, "prepared for editing"),
    );
    return { edited: input.ref, navigationEpoch: target.navigationEpoch, origin, tabId: target.id };
  }

  private resolveTarget(binding: BrowserAgentBinding, requestedTabId: unknown): BoundBrowserAgentTarget {
    if (requestedTabId !== undefined && requestedTabId !== null && typeof requestedTabId !== "string") {
      throw new Error("Browser tab id is invalid");
    }
    if (typeof requestedTabId === "string" && requestedTabId) {
      for (const contextId of binding.contextIds) {
        const snapshot = this.panes.getState(contextId);
        if (snapshot?.tabs.some((tab) => tab.id === requestedTabId)) {
          return { ...this.panes.resolveAgentTab(contextId, requestedTabId), contextId };
        }
      }
      throw new Error("Browser tab is not attached to this chat session");
    }
    return {
      ...this.panes.resolveAgentTab(binding.activeContextId),
      contextId: binding.activeContextId,
    };
  }

  private resolveActionTarget(
    binding: BrowserAgentBinding,
    input: { ref: string; tabId?: string | null } | null | undefined,
  ) {
    if (!input || typeof input.ref !== "string" || !REF_PATTERN.test(input.ref)) {
      throw new Error("Browser element ref is invalid; call read_page again");
    }
    return this.resolveTarget(binding, input.tabId);
  }

  private requireTargetOrigin(url: string): string {
    const origin = browserOrigin(url);
    if (!origin) throw new Error("The selected Browser tab does not have a readable web origin");
    return origin;
  }

  private async ensureOriginAccess(
    sessionId: string,
    binding: BrowserAgentBinding,
    origin: string,
    tool: string,
    target: BoundBrowserAgentTarget,
  ): Promise<void> {
    if (binding.grantedOrigins.has(origin)) return;
    const approved = await this.options.authorizeOrigin({ origin, sessionId, tool });
    if (!approved) throw new Error(`User denied agent access to ${origin}`);
    this.assertTargetStable(binding, target, browserOrigin(target.url), "approved");
    binding.grantedOrigins.add(origin);
  }

  private assertTargetStable(
    binding: BrowserAgentBinding,
    target: BoundBrowserAgentTarget,
    origin: string | null,
    action: string,
  ): void {
    const current = this.panes.resolveAgentTab(target.contextId, target.id);
    if (current.navigationEpoch !== target.navigationEpoch || browserOrigin(current.url) !== origin) {
      throw new Error(`The Browser page navigated while it was being ${action}; call read_page again`);
    }
  }

  private assertId(value: string, label: string): void {
    if (!ID_PATTERN.test(value)) throw new Error(`Browser agent ${label} id is invalid`);
  }
}
