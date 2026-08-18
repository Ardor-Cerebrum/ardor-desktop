import type { BrowserTabHandle } from "./browser-surface";
import { evaluateInBrowserAgentWorld } from "./agent-read-page";

export interface BrowserAgentPoint {
  x: number;
  y: number;
}

export interface BrowserAgentScreenshot {
  data: string;
  height: number;
  mimeType: "image/jpeg";
  scale: number;
  viewportHeight: number;
  viewportWidth: number;
  width: number;
}

interface LayoutMetrics {
  cssVisualViewport?: { clientHeight?: unknown; clientWidth?: unknown; pageX?: unknown; pageY?: unknown };
  visualViewport?: { clientHeight?: unknown; clientWidth?: unknown; pageX?: unknown; pageY?: unknown };
}

interface ScreenshotResponse {
  data?: unknown;
}

const MAX_SCREENSHOT_WIDTH = 800;
const REF_PATTERN = /^ref_[1-9][0-9]{0,7}$/;

function actionExpression(ref: string, action: string): string {
  return `(() => {
    const element = globalThis.__ardorBrowserAgentState?.elements?.get(${JSON.stringify(ref)});
    if (!(element instanceof HTMLElement) || !element.isConnected) {
      return { error: "Element ref is stale; call read_page again" };
    }
    ${action}
  })()`;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Browser page action failed");
  const result = value as Record<string, unknown>;
  if (typeof result.error === "string") throw new Error(result.error);
  return result;
}

function requirePoint(value: unknown): BrowserAgentPoint {
  const point = requireRecord(value);
  if (typeof point.x !== "number" || typeof point.y !== "number") throw new Error("Browser element has no actionable point");
  return { x: point.x, y: point.y };
}

export async function resolveBrowserElementPoint(handle: BrowserTabHandle, ref: string): Promise<BrowserAgentPoint> {
  if (!REF_PATTERN.test(ref)) throw new Error("Browser element ref is invalid; call read_page again");
  return requirePoint(
    await evaluateInBrowserAgentWorld(
      handle,
      actionExpression(
        ref,
        `element.scrollIntoView({ block: "center", inline: "center" });
         const rect = element.getBoundingClientRect();
         if (rect.width <= 0 || rect.height <= 0) return { error: "Element has no visible bounds" };
         return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`,
      ),
    ),
  );
}

export async function scrollBrowserElementIntoView(handle: BrowserTabHandle, ref: string): Promise<void> {
  const result = requireRecord(
    await evaluateInBrowserAgentWorld(
      handle,
      actionExpression(ref, `element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); return { ok: true };`),
    ),
  );
  if (result.ok !== true) throw new Error("Browser element could not be scrolled into view");
}

export async function focusBrowserElement(handle: BrowserTabHandle, ref: string): Promise<void> {
  const result = requireRecord(
    await evaluateInBrowserAgentWorld(
      handle,
      actionExpression(ref, `element.scrollIntoView({ block: "center", inline: "center" }); element.focus(); return { ok: true };`),
    ),
  );
  if (result.ok !== true) throw new Error("Browser element could not be focused");
}

export async function captureBrowserAgentScreenshot(handle: BrowserTabHandle): Promise<BrowserAgentScreenshot> {
  const metrics = (await handle.sendCommand("Page.getLayoutMetrics")) as LayoutMetrics;
  const viewport = metrics.cssVisualViewport ?? metrics.visualViewport;
  const viewportWidth = Number(viewport?.clientWidth);
  const viewportHeight = Number(viewport?.clientHeight);
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) throw new Error("Browser viewport is unavailable");
  const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / viewportWidth);
  const response = (await handle.sendCommand("Page.captureScreenshot", {
    captureBeyondViewport: false,
    clip: {
      height: viewportHeight,
      scale,
      width: viewportWidth,
      x: Number(viewport?.pageX) || 0,
      y: Number(viewport?.pageY) || 0,
    },
    format: "jpeg",
    fromSurface: true,
    quality: 75,
  })) as ScreenshotResponse;
  if (typeof response.data !== "string" || !response.data) throw new Error("Browser screenshot is unavailable");
  return {
    data: response.data,
    height: Math.max(1, Math.round(viewportHeight * scale)),
    mimeType: "image/jpeg",
    scale,
    viewportHeight,
    viewportWidth,
    width: Math.max(1, Math.round(viewportWidth * scale)),
  };
}

export async function dispatchBrowserClick(
  handle: BrowserTabHandle,
  point: BrowserAgentPoint,
  options: { button: "left" | "right"; clickCount: 1 | 2 | 3; modifiers: number },
): Promise<void> {
  await handle.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point, modifiers: options.modifiers });
  await handle.sendCommand("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: options.button,
    clickCount: options.clickCount,
    modifiers: options.modifiers,
  });
  await handle.sendCommand("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: options.button,
    clickCount: options.clickCount,
    modifiers: options.modifiers,
  });
}

export async function dispatchBrowserHover(handle: BrowserTabHandle, point: BrowserAgentPoint): Promise<void> {
  await handle.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
}

export async function dispatchBrowserScroll(
  handle: BrowserTabHandle,
  point: BrowserAgentPoint,
  direction: "down" | "left" | "right" | "up",
  amount: number,
): Promise<void> {
  const delta = Math.min(10, Math.max(1, amount)) * 100;
  const deltaX = direction === "left" ? -delta : direction === "right" ? delta : 0;
  const deltaY = direction === "up" ? -delta : direction === "down" ? delta : 0;
  await handle.sendCommand("Input.dispatchMouseEvent", { type: "mouseWheel", ...point, deltaX, deltaY });
}

export async function dispatchBrowserDrag(
  handle: BrowserTabHandle,
  start: BrowserAgentPoint,
  end: BrowserAgentPoint,
): Promise<void> {
  await handle.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...start });
  await handle.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...start, button: "left", clickCount: 1 });
  const steps = 10;
  for (let index = 1; index <= steps; index += 1) {
    await handle.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      button: "left",
      buttons: 1,
      x: start.x + ((end.x - start.x) * index) / steps,
      y: start.y + ((end.y - start.y) * index) / steps,
    });
  }
  await handle.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...end, button: "left", clickCount: 1 });
}

export async function dispatchBrowserText(handle: BrowserTabHandle, text: string): Promise<void> {
  await handle.sendCommand("Input.insertText", { text });
}

const SPECIAL_KEYS: Record<string, { code: string; key: string }> = {
  ARROWDOWN: { code: "ArrowDown", key: "ArrowDown" },
  ARROWLEFT: { code: "ArrowLeft", key: "ArrowLeft" },
  ARROWRIGHT: { code: "ArrowRight", key: "ArrowRight" },
  ARROWUP: { code: "ArrowUp", key: "ArrowUp" },
  BACKSPACE: { code: "Backspace", key: "Backspace" },
  DELETE: { code: "Delete", key: "Delete" },
  END: { code: "End", key: "End" },
  ENTER: { code: "Enter", key: "Enter" },
  ESCAPE: { code: "Escape", key: "Escape" },
  HOME: { code: "Home", key: "Home" },
  PAGEDOWN: { code: "PageDown", key: "PageDown" },
  PAGEUP: { code: "PageUp", key: "PageUp" },
  SPACE: { code: "Space", key: " " },
  TAB: { code: "Tab", key: "Tab" },
};

function parseKeyToken(token: string): { code: string; key: string; modifiers: number; text?: string } {
  const parts = token.split("+");
  let keyPart = parts.pop() || "+";
  let modifiers = 0;
  for (const raw of parts) {
    switch (raw.toLowerCase()) {
      case "alt":
        modifiers |= 1;
        break;
      case "control":
      case "ctrl":
        modifiers |= 2;
        break;
      case "cmd":
      case "meta":
      case "win":
      case "windows":
        modifiers |= 4;
        break;
      case "shift":
        modifiers |= 8;
        break;
    }
  }
  const special = SPECIAL_KEYS[keyPart.toUpperCase()];
  if (special) return { ...special, modifiers };
  if (keyPart.length !== 1) keyPart = keyPart.slice(0, 64);
  return { code: keyPart.length === 1 ? `Key${keyPart.toUpperCase()}` : keyPart, key: keyPart, modifiers, ...(modifiers === 0 ? { text: keyPart } : {}) };
}

export async function dispatchBrowserKeys(handle: BrowserTabHandle, sequence: string, repeat: number): Promise<void> {
  const tokens = sequence.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length * repeat > 100) throw new Error("Browser key sequence is empty or too long");
  for (let iteration = 0; iteration < repeat; iteration += 1) {
    for (const token of tokens) {
      const key = parseKeyToken(token);
      await handle.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
      await handle.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", code: key.code, key: key.key, modifiers: key.modifiers });
    }
  }
}

export function parseModifierBits(value: string | undefined): number {
  if (!value) return 0;
  let modifiers = 0;
  for (const raw of value.toLowerCase().split("+")) {
    if (raw === "alt") modifiers |= 1;
    else if (raw === "control" || raw === "ctrl") modifiers |= 2;
    else if (["cmd", "meta", "win", "windows"].includes(raw)) modifiers |= 4;
    else if (raw === "shift") modifiers |= 8;
  }
  return modifiers;
}
