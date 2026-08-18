import type { BrowserTabHandle } from "./browser-surface";
import { evaluateInBrowserAgentWorld } from "./agent-read-page";

interface PointResult {
  ok: true;
  x: number;
  y: number;
}

interface FocusResult {
  ok: true;
}

function actionExpression(ref: string, action: string): string {
  return `(() => {
    const element = globalThis.__ardorBrowserAgentState?.elements?.get(${JSON.stringify(ref)});
    if (!(element instanceof HTMLElement) || !element.isConnected) {
      return { ok: false, error: "Element ref is stale; call browser_read_page again" };
    }
    ${action}
  })()`;
}

function assertOk<T extends { ok: true }>(value: unknown): T {
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as { ok?: unknown }).ok !== true) {
    const error = (value as { error?: unknown } | null)?.error;
    throw new Error(typeof error === "string" ? error : "Browser page action failed");
  }
  return value as T;
}

export async function clickBrowserPageElement(
  handle: BrowserTabHandle,
  ref: string,
  beforeDispatch: () => void,
): Promise<void> {
  const point = assertOk<PointResult>(
    await evaluateInBrowserAgentWorld(
      handle,
      actionExpression(
        ref,
        `element.scrollIntoView({ block: "center", inline: "center" });
         const rect = element.getBoundingClientRect();
         if (rect.width <= 0 || rect.height <= 0) return { ok: false, error: "Element is not clickable" };
         return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };`,
      ),
    ),
  );
  beforeDispatch();
  await handle.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await handle.sendCommand("Input.dispatchMouseEvent", {
    button: "left",
    clickCount: 1,
    type: "mousePressed",
    x: point.x,
    y: point.y,
  });
  await handle.sendCommand("Input.dispatchMouseEvent", {
    button: "left",
    clickCount: 1,
    type: "mouseReleased",
    x: point.x,
    y: point.y,
  });
}

export async function typeIntoBrowserPageElement(
  handle: BrowserTabHandle,
  ref: string,
  text: string,
  submit: boolean,
  beforeDispatch: () => void,
): Promise<void> {
  assertOk<FocusResult>(
    await evaluateInBrowserAgentWorld(
      handle,
      actionExpression(
        ref,
        `const type = element instanceof HTMLInputElement ? element.type.toLowerCase() : "";
         const autocomplete = String(element.getAttribute("autocomplete") || "").toLowerCase();
         if (type === "password" || type === "hidden" || [
           "current-password", "new-password", "one-time-code", "cc-number", "cc-csc",
           "cc-exp", "cc-exp-month", "cc-exp-year"
         ].includes(autocomplete)) {
           return { ok: false, error: "Agent typing into sensitive fields is blocked" };
         }
         element.scrollIntoView({ block: "center", inline: "center" });
         element.focus();
         if (typeof element.select === "function") element.select();
         return { ok: true };`,
      ),
    ),
  );
  beforeDispatch();
  await handle.sendCommand("Input.insertText", { text });
  if (submit) {
    await handle.sendCommand("Input.dispatchKeyEvent", { key: "Enter", type: "rawKeyDown" });
    await handle.sendCommand("Input.dispatchKeyEvent", { key: "Enter", type: "keyUp" });
  }
}
