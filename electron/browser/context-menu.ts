import type { ContextMenuParams, MenuItemConstructorOptions } from "electron";

export interface BrowserPageContextMenuActions {
  copyImage(x: number, y: number): void;
  copyText(value: string): void;
  inspectElement(x: number, y: number): void;
  learnSpelling(word: string): void;
  lookUpSelection(): void;
  openExternal(url: string): void;
  replaceMisspelling(value: string): void;
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function buildBrowserPageContextMenuTemplate(
  params: ContextMenuParams,
  actions: BrowserPageContextMenuActions,
  allowInspectElement: boolean,
): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [];
  let needsSeparator = false;
  const startGroup = () => {
    if (needsSeparator) template.push({ type: "separator" });
    needsSeparator = false;
  };
  const finishGroup = () => {
    needsSeparator = true;
  };

  for (const suggestion of params.dictionarySuggestions) {
    template.push({ label: suggestion, click: () => actions.replaceMisspelling(suggestion) });
    finishGroup();
  }

  if (params.misspelledWord) {
    startGroup();
    template.push({
      label: "Learn Spelling",
      click: () => actions.learnSpelling(params.misspelledWord),
    });
    finishGroup();
  }

  if (params.selectionText) {
    startGroup();
    template.push({ label: "Look Up", click: actions.lookUpSelection });
    finishGroup();
  }

  if (params.linkURL) {
    startGroup();
    if (isSafeExternalUrl(params.linkURL)) {
      template.push({
        label: "Open Link in Default Browser",
        click: () => actions.openExternal(params.linkURL),
      });
    }
    template.push({
      label: "Copy Link Address",
      click: () => actions.copyText(params.linkURL),
    });
    finishGroup();
  }

  if (params.hasImageContents) {
    startGroup();
    template.push({ label: "Copy Image", click: () => actions.copyImage(params.x, params.y) });
    if (params.srcURL) {
      template.push({
        label: "Copy Image Address",
        click: () => actions.copyText(params.srcURL),
      });
    }
    finishGroup();
  }

  const { editFlags } = params;
  if (params.isEditable && (editFlags.canUndo || editFlags.canRedo)) {
    startGroup();
    template.push(
      {
        label: "Undo",
        accelerator: "CmdOrCtrl+Z",
        role: "undo",
        enabled: editFlags.canUndo,
      },
      {
        label: "Redo",
        accelerator: "CmdOrCtrl+Shift+Z",
        role: "redo",
        enabled: editFlags.canRedo,
      },
    );
    finishGroup();
  }

  startGroup();
  if (params.isEditable) {
    template.push(
      {
        label: "Cut",
        accelerator: "CmdOrCtrl+X",
        role: "cut",
        enabled: editFlags.canCut,
      },
      {
        label: "Copy",
        accelerator: "CmdOrCtrl+C",
        role: "copy",
        enabled: editFlags.canCopy,
      },
      {
        label: "Paste",
        accelerator: "CmdOrCtrl+V",
        role: "paste",
        enabled: editFlags.canPaste,
      },
    );
  } else {
    template.push({
      label: "Copy",
      accelerator: "CmdOrCtrl+C",
      role: "copy",
      enabled: editFlags.canCopy,
    });
  }
  finishGroup();

  if (editFlags.canSelectAll) {
    startGroup();
    template.push({
      label: "Select All",
      accelerator: "CmdOrCtrl+A",
      role: "selectAll",
    });
    finishGroup();
  }

  if (allowInspectElement) {
    startGroup();
    template.push({
      label: "Inspect Element",
      click: () => actions.inspectElement(params.x, params.y),
    });
  }

  return template;
}
