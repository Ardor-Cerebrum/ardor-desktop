import type { Input } from "electron";

export type BrowserTabShortcut = "newTab" | "closeTab";
export type BrowserTabShortcutMatch = BrowserTabShortcut | "claim";

export function matchBrowserTabShortcut(
  input: Input,
  platform: NodeJS.Platform = process.platform,
  syntheticSuppressed = false,
): BrowserTabShortcutMatch | undefined {
  if (input.type !== "keyDown") return undefined;

  const isMac = platform === "darwin";
  const primaryModifierPressed = isMac ? input.meta : input.control;
  const otherPlatformModifierPressed = isMac ? input.control : input.meta;
  if (!primaryModifierPressed || otherPlatformModifierPressed || input.shift || input.alt) {
    return undefined;
  }

  let shortcut: BrowserTabShortcut;
  switch (input.key.toLowerCase()) {
    case "t":
      shortcut = "newTab";
      break;
    case "w":
      shortcut = "closeTab";
      break;
    default:
      return undefined;
  }
  return input.isAutoRepeat || syntheticSuppressed ? "claim" : shortcut;
}
