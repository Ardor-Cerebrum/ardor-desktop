import { createHash } from "node:crypto";

import type {
  BrowserAutomationRequest,
  BrowserAutomationResult,
  BrowserBounds,
  BrowserHost,
  BrowserTabHandle,
} from "./controller";
import { applyBrowserSurfacePresentation } from "./controller";
import type { BrowserSurfacePresentation } from "../bridge-contract";
import {
  isAllowedBrowserOrigin,
  isBrowserNavigableUrl,
  truncateBrowserPayload,
  validateBrowserAutomationRequest,
} from "./security";

export interface ArtifactPaneSnapshot {
  contextId: string;
  generation: number;
  url: string;
  loading: boolean;
}

interface ArtifactPaneContext {
  id: string;
  generation: number;
  origin: string;
  handle: BrowserTabHandle;
}

export interface ArtifactPaneControllerOptions {
  maxResultBytes?: number;
}

const DEFAULT_MAX_RESULT_BYTES = 256 * 1024;
const CONTEXT_ID_PATTERN = /^[a-zA-Z0-9:_./-]{1,256}$/;

const partitionForContext = (contextId: string, generation: number) =>
  `ardor-artifact-preview-${createHash("sha256").update(`${contextId}:${generation}`).digest("hex").slice(0, 24)}`;

export class ArtifactPaneController {
  private readonly contexts = new Map<string, ArtifactPaneContext>();
  private readonly maxResultBytes: number;
  private nextGeneration = 1;

  constructor(private readonly host: BrowserHost, options: ArtifactPaneControllerOptions = {}) {
    this.maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
    if (!Number.isSafeInteger(this.maxResultBytes) || this.maxResultBytes < 1) {
      throw new RangeError("maxResultBytes must be a positive safe integer");
    }
  }

  async open(contextId: string, bounds: BrowserBounds, url: string): Promise<ArtifactPaneSnapshot> {
    this.assertContextId(contextId);
    this.assertBounds(bounds, true);
    const normalizedUrl = this.assertNavigableUrl(url);
    const origin = new URL(normalizedUrl).origin;
    const existing = this.contexts.get(contextId);
    if (existing) {
      if (existing.origin !== origin) {
        await this.close(contextId);
        return this.open(contextId, bounds, normalizedUrl);
      }
      existing.handle.setBounds(bounds);
      applyBrowserSurfacePresentation(existing.handle, "visible");
      if (existing.handle.url() !== normalizedUrl) {
        await existing.handle.load(normalizedUrl);
      }
      return this.snapshot(existing);
    }

    const generation = this.nextGeneration++;
    const handle = this.host.create(
      `artifact-${generation}`,
      partitionForContext(contextId, generation),
      undefined,
      {
        isNavigationAllowed: (candidateUrl) =>
          candidateUrl === "about:blank" || isAllowedBrowserOrigin(candidateUrl, [origin]),
        isPermissionAllowed: (permission, requestingUrl) =>
          permission === "clipboard-sanitized-write" &&
          Boolean(requestingUrl && isAllowedBrowserOrigin(requestingUrl, [origin])),
      },
    );
    const context: ArtifactPaneContext = { id: contextId, generation, origin, handle };
    this.contexts.set(contextId, context);
    handle.setBounds(bounds);
    applyBrowserSurfacePresentation(handle, "visible");
    try {
      await handle.load(normalizedUrl);
    } catch (error) {
      this.contexts.delete(contextId);
      handle.close();
      throw error;
    }
    return this.snapshot(context);
  }

  layout(
    contextId: string,
    bounds: BrowserBounds,
    presentation: BrowserSurfacePresentation,
  ): ArtifactPaneSnapshot {
    const context = this.requireContext(contextId);
    this.assertBounds(bounds, presentation === "visible");
    context.handle.setBounds(bounds);
    applyBrowserSurfacePresentation(context.handle, presentation);
    return this.snapshot(context);
  }

  capture(contextId: string): Promise<string | null> {
    const context = this.requireContext(contextId);
    return context.handle.capturePage?.() ?? Promise.resolve(null);
  }

  async reload(contextId: string, url?: string): Promise<ArtifactPaneSnapshot> {
    const context = this.requireContext(contextId);
    if (url) {
      const normalizedUrl = this.assertNavigableUrl(url);
      if (!isAllowedBrowserOrigin(normalizedUrl, [context.origin])) {
        throw new Error("artifact preview origin is not granted");
      }
      await context.handle.load(normalizedUrl);
    } else {
      context.handle.reload?.();
    }
    return this.snapshot(context);
  }

  async automate(contextId: string, request: BrowserAutomationRequest): Promise<BrowserAutomationResult> {
    const context = this.requireContext(contextId);
    if (!isAllowedBrowserOrigin(context.handle.url(), [context.origin])) {
      throw new Error("artifact preview origin is not granted");
    }
    const params = validateBrowserAutomationRequest(request.method, request.params);
    const rawResult = await context.handle.sendCommand(request.method, params);
    const commandResult =
      rawResult && typeof rawResult === "object" && "result" in rawResult
        ? (rawResult as { result: unknown }).result
        : rawResult;
    const bounded = truncateBrowserPayload(commandResult, this.maxResultBytes);
    if (bounded.truncated) {
      return { generation: context.generation, result: { truncated: true, value: bounded.value } };
    }
    const parsed = JSON.parse(bounded.value) as unknown;
    return {
      generation: context.generation,
      result:
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { value: parsed },
    };
  }

  async close(contextId: string): Promise<boolean> {
    const context = this.contexts.get(contextId);
    if (!context) return false;
    this.contexts.delete(contextId);
    applyBrowserSurfacePresentation(context.handle, "hidden");
    if (context.handle.clearSiteData) {
      await context.handle.clearSiteData().catch(() => false);
    }
    context.handle.close();
    return true;
  }

  dispose(): void {
    for (const context of this.contexts.values()) {
      applyBrowserSurfacePresentation(context.handle, "hidden");
      context.handle.close();
    }
    this.contexts.clear();
  }

  private snapshot(context: ArtifactPaneContext): ArtifactPaneSnapshot {
    return {
      contextId: context.id,
      generation: context.generation,
      url: context.handle.url(),
      loading: context.handle.isLoading?.() ?? false,
    };
  }

  private requireContext(contextId: string): ArtifactPaneContext {
    this.assertContextId(contextId);
    const context = this.contexts.get(contextId);
    if (!context) throw new Error("artifact pane is unavailable");
    return context;
  }

  private assertContextId(contextId: string): void {
    if (!CONTEXT_ID_PATTERN.test(contextId)) {
      throw new Error("artifact context id is invalid");
    }
  }

  private assertNavigableUrl(value: string): string {
    if (!isBrowserNavigableUrl(value)) {
      throw new Error("artifact preview URL must be public HTTPS or loopback HTTP(S)");
    }
    return new URL(value).toString();
  }

  private assertBounds(bounds: BrowserBounds, visible: boolean): void {
    if (
      !Number.isFinite(bounds.x) ||
      !Number.isFinite(bounds.y) ||
      !Number.isFinite(bounds.width) ||
      !Number.isFinite(bounds.height) ||
      bounds.x < 0 ||
      bounds.y < 0 ||
      bounds.width < 0 ||
      bounds.height < 0 ||
      (visible && (bounds.width === 0 || bounds.height === 0))
    ) {
      throw new Error("artifact preview bounds are invalid");
    }
  }
}
