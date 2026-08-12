import { describe, expect, mock, test } from "bun:test";

import { BrowserElementPicker } from "./element-picker";

function createImage(width: number, height: number, bytes = "picked") {
  const resized = {
    getSize: () => ({ width: 1200, height: 600 }),
    resize: mock(() => resized),
    toPNG: () => Buffer.from(bytes),
  };
  return {
    image: {
      getSize: () => ({ width, height }),
      resize: mock(() => resized),
      toPNG: () => Buffer.from(bytes),
    },
    resized,
  };
}

describe("BrowserElementPicker", () => {
  test("selects through the overlay and emits bounded element context", async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const sendCommand = mock(async (method: string, params?: Record<string, unknown>) => {
      calls.push([method, params]);
      switch (method) {
        case "DOM.describeNode":
          return {
            node: {
              nodeId: 7,
              nodeName: "BUTTON",
              attributes: [
                "id",
                "save",
                "class",
                "primary large",
                "aria-label",
                "Save changes",
                "href",
                "/saved",
                "data-secret",
                "hidden",
              ],
            },
          };
        case "CSS.getComputedStyleForNode":
          return {
            computedStyle: [
              { name: "display", value: "flex" },
              { name: "color", value: "rgb(1, 2, 3)" },
              { name: "unknown", value: "ignored" },
            ],
          };
        case "DOM.getBoxModel":
          return { model: { content: [40, 120, 240, 120, 240, 180, 40, 180] } };
        case "DOM.resolveNode":
          return { object: { objectId: "object-1" } };
        case "Runtime.callFunctionOn": {
          const declaration = String(params?.functionDeclaration ?? "");
          if (declaration.includes("__reactFiber$")) {
            return {
              result: {
                value: {
                  name: "SaveButton",
                  ancestors: ["Editor", "Page"],
                  props: { disabled: false, onClick: "[function]" },
                  source: "/src/save.tsx:42",
                },
              },
            };
          }
          if (declaration.includes("innerText")) return { result: { value: "Save changes" } };
          if (declaration.includes("const parts")) return { result: { value: "main#app > form.editor" } };
          return {
            result: {
              value: {
                outer: '<button id="save">Save changes</button>',
                sibling: '<!-- SELECTED --><button id="save">Save changes</button>',
              },
            },
          };
        }
        case "Runtime.evaluate":
          return { result: { value: JSON.stringify({ x: 5, y: 10 }) } };
        default:
          return {};
      }
    });
    const native = createImage(2400, 1200);
    const capturePage = mock(async () => native.image as never);
    let resolveSelection!: (value: unknown) => void;
    const selected = new Promise((resolve) => {
      resolveSelection = resolve;
    });
    const picker = new BrowserElementPicker({
      capturePage,
      isDestroyed: () => false,
      onSelected: resolveSelection,
      sendCommand,
    });

    expect(await picker.setEnabled(true)).toBe(true);
    picker.handleDebuggerMessage("Overlay.inspectNodeRequested", { backendNodeId: 99 });
    const selection = await selected;
    await Promise.resolve();

    expect(selection).toEqual({
      tagName: "button",
      id: "save",
      classes: ["primary", "large"],
      attributes: { "aria-label": "Save changes", href: "/saved" },
      computedStyles: { display: "flex", color: "rgb(1, 2, 3)" },
      boundingBox: { x: 40, y: 120, width: 200, height: 60 },
      screenshot: Buffer.from("picked").toString("base64"),
      innerText: "Save changes",
      parentPath: "main#app > form.editor",
      action: "navigates to: /saved",
      reactComponent: "SaveButton (in Editor > Page)",
      reactProps: { disabled: false, onClick: "[function]" },
      sourceFile: "/src/save.tsx:42",
      outerHTML: '<button id="save">Save changes</button>',
      siblingHTML: '<!-- SELECTED --><button id="save">Save changes</button>',
    });
    expect(capturePage).toHaveBeenCalledWith({ x: 0, y: 30, width: 360, height: 220 });
    expect(native.image.resize).toHaveBeenCalledWith({ width: 1200, height: 600 });
    expect(calls.filter(([method]) => method === "Overlay.setInspectMode").at(-1)?.[1]).toMatchObject({
      mode: "searchForNode",
    });
  });

  test("disables the overlay and ignores later inspect events", async () => {
    const onSelected = mock(() => undefined);
    const sendCommand = mock(async () => ({}));
    const picker = new BrowserElementPicker({
      capturePage: async () => createImage(1, 1).image as never,
      isDestroyed: () => false,
      onSelected,
      sendCommand,
    });

    await picker.setEnabled(true);
    expect(await picker.setEnabled(false)).toBe(true);
    picker.handleDebuggerMessage("Overlay.inspectNodeRequested", { backendNodeId: 1 });
    await Promise.resolve();

    expect(onSelected).not.toHaveBeenCalled();
    expect(sendCommand.mock.calls.slice(-4).map(([method]) => method)).toEqual([
      "Overlay.hideHighlight",
      "Overlay.setInspectMode",
      "Overlay.disable",
      "DOM.disable",
    ]);
  });

  test("reports unavailable selection when inspect mode cannot be enabled", async () => {
    const picker = new BrowserElementPicker({
      capturePage: async () => createImage(1, 1).image as never,
      isDestroyed: () => false,
      onSelected: () => undefined,
      sendCommand: async () => {
        throw new Error("debugger unavailable");
      },
    });

    expect(await picker.setEnabled(true)).toBe(false);
  });
});
