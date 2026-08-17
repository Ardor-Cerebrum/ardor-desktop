import { describe, expect, mock, test } from "bun:test";
import type { ContextMenuParams, EditFlags } from "electron";

import {
  buildBrowserPageContextMenuTemplate,
  type BrowserPageContextMenuActions,
} from "./context-menu";

const editFlags: EditFlags = {
  canCopy: false,
  canCut: false,
  canDelete: false,
  canEditRichly: false,
  canPaste: false,
  canRedo: false,
  canSelectAll: true,
  canUndo: false,
};

function params(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    altText: "",
    dictionarySuggestions: [],
    editFlags,
    formControlType: "none",
    frame: null,
    frameCharset: "",
    frameURL: "https://example.test/",
    hasImageContents: false,
    isEditable: false,
    linkText: "",
    linkURL: "",
    mediaFlags: {
      canLoop: false,
      canMute: false,
      canPrint: false,
      canRotate: false,
      canSave: false,
      hasAudio: false,
      hasVideo: false,
      inError: false,
      isControlsVisible: false,
      isLooping: false,
      isMuted: false,
      isPaused: false,
      isPlaying: false,
    },
    mediaType: "none",
    menuSourceType: "mouse",
    misspelledWord: "",
    pageURL: "https://example.test/",
    referrerPolicy: "default",
    selectionRect: { x: 0, y: 0, width: 0, height: 0 },
    selectionStartOffset: 0,
    selectionText: "",
    spellcheckEnabled: true,
    srcURL: "",
    suggestedFilename: "",
    titleText: "",
    x: 12,
    y: 18,
    ...overrides,
  };
}

function actions(): BrowserPageContextMenuActions {
  return {
    copyImage: mock(() => undefined),
    copyText: mock(() => undefined),
    inspectElement: mock(() => undefined),
    learnSpelling: mock(() => undefined),
    lookUpSelection: mock(() => undefined),
    openExternal: mock(() => undefined),
    replaceMisspelling: mock(() => undefined),
  };
}

function itemLabels(template: ReturnType<typeof buildBrowserPageContextMenuTemplate>) {
  return template.map((item) => item.type === "separator" ? "separator" : item.label);
}

test("builds the native spelling, lookup, link, image, edit, and inspect groups", () => {
  const handlers = actions();
  const template = buildBrowserPageContextMenuTemplate(
    params({
      dictionarySuggestions: ["browser"],
      editFlags: { ...editFlags, canCopy: true, canCut: true, canPaste: true, canUndo: true },
      hasImageContents: true,
      isEditable: true,
      linkURL: "https://example.test/path",
      misspelledWord: "browzer",
      selectionText: "selected",
      srcURL: "https://example.test/image.png",
    }),
    handlers,
    true,
  );

  expect(itemLabels(template)).toEqual([
    "browser",
    "separator",
    "Learn Spelling",
    "separator",
    "Look Up",
    "separator",
    "Open Link in Default Browser",
    "Copy Link Address",
    "separator",
    "Copy Image",
    "Copy Image Address",
    "separator",
    "Undo",
    "Redo",
    "separator",
    "Cut",
    "Copy",
    "Paste",
    "separator",
    "Select All",
    "separator",
    "Inspect Element",
  ]);

  template.find((item) => item.label === "browser")?.click?.({} as never, undefined, {} as never);
  template.find((item) => item.label === "Open Link in Default Browser")?.click?.({} as never, undefined, {} as never);
  template.find((item) => item.label === "Copy Image")?.click?.({} as never, undefined, {} as never);
  expect(handlers.replaceMisspelling).toHaveBeenCalledWith("browser");
  expect(handlers.openExternal).toHaveBeenCalledWith("https://example.test/path");
  expect(handlers.copyImage).toHaveBeenCalledWith(12, 18);
});

describe("external link safety", () => {
  test.each([
    "https://user:secret@example.test/private",
    "file:///tmp/private",
    "javascript:alert(1)",
  ])("does not offer external open for %s", (linkURL) => {
    const template = buildBrowserPageContextMenuTemplate(params({ linkURL }), actions(), false);

    expect(itemLabels(template)).not.toContain("Open Link in Default Browser");
    expect(itemLabels(template)).toContain("Copy Link Address");
  });
});
