import type { NativeImage, Rectangle } from "electron";

import type { BrowserElementSelection } from "../bridge-contract";

type SendCommand = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export interface BrowserElementPickerOptions {
  capturePage(bounds?: Rectangle): Promise<NativeImage>;
  isDestroyed(): boolean;
  onSelected(selection: BrowserElementSelection): void;
  sendCommand: SendCommand;
}

const STYLE_PROPERTIES = [
  "display",
  "position",
  "flex-direction",
  "justify-content",
  "align-items",
  "width",
  "height",
  "padding",
  "margin",
  "background-color",
  "color",
  "font-size",
  "font-weight",
  "border-radius",
  "border",
] as const;

const ATTRIBUTE_ALLOWLIST = [
  "data-testid",
  "data-test-id",
  "aria-label",
  "name",
  "type",
  "href",
  "role",
  "placeholder",
  "title",
  "alt",
  "onclick",
  "value",
  "src",
] as const;

const HIGHLIGHT_CONFIG = Object.freeze({
  showInfo: true,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
});

const REACT_CONTEXT_FUNCTION = `function() {
  var key = Object.keys(this).find(function(k) {
    return k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$');
  });
  if (!key) return null;
  var fiber = this[key];
  function isUsefulName(n) {
    return n && n.length > 1 && n !== 'Anonymous';
  }
  while (fiber && (!fiber.type || typeof fiber.type === 'string' || !isUsefulName(fiber.type.displayName || fiber.type.name))) {
    fiber = fiber.return;
  }
  if (!fiber || !fiber.type) return null;
  var name = fiber.type.displayName || fiber.type.name || null;
  if (!name) return null;
  var ancestors = [];
  var parent = fiber.return;
  for (var i = 0; i < 4 && parent; parent = parent.return) {
    if (parent.type && typeof parent.type !== 'string') {
      var pn = parent.type.displayName || parent.type.name;
      if (isUsefulName(pn)) {
        ancestors.push(pn);
        i++;
      }
    }
  }
  var source = null;
  try {
    var src = fiber._debugSource;
    if (src && src.fileName) {
      source = src.fileName;
      if (src.lineNumber) source += ':' + src.lineNumber;
    }
  } catch(e) {}
  var props = {};
  try {
    var mp = fiber.memoizedProps || {};
    Object.keys(mp).forEach(function(k) {
      if (k === 'children') return;
      var v = mp[k];
      var t = typeof v;
      if (t === 'string' || t === 'number' || t === 'boolean' || v === null) props[k] = v;
      else if (t === 'function') props[k] = '[function]';
      else if (Array.isArray(v)) props[k] = '[array(' + v.length + ')]';
      else if (t === 'object') props[k] = '[object]';
    });
  } catch(e) {}
  return { name: name, props: props, ancestors: ancestors, source: source };
}`;

const INNER_TEXT_FUNCTION = "function() { return this.innerText?.substring(0, 200) || ''; }";
const PARENT_PATH_FUNCTION = `function() {
  const parts = [];
  let el = this.parentElement;
  for (let i = 0; i < 4 && el && el !== document.body; i++) {
    let selector = el.tagName.toLowerCase();
    if (el.id) selector += '#' + el.id;
    else if (el.getAttribute('class')) selector += '.' + el.getAttribute('class').split(' ')[0];
    parts.unshift(selector);
    el = el.parentElement;
  }
  return parts.join(' > ');
}`;
const HTML_CONTEXT_FUNCTION = `function() {
  var outer = this.outerHTML;
  if (outer && outer.length > 2000) outer = outer.substring(0, 2000) + '...';
  var sibling = null;
  if (this.parentElement) {
    var children = Array.from(this.parentElement.children);
    var parts = children.map(function(child) {
      if (child === this) return '<!-- SELECTED -->' + child.outerHTML;
      var tag = child.tagName.toLowerCase();
      var rawCls = child.getAttribute('class') || '';
      var cls = rawCls ? ' class="' + rawCls.split(' ').slice(0, 3).join(' ') + '"' : '';
      var id = child.id ? ' id="' + child.id + '"' : '';
      return '<' + tag + id + cls + ' />';
    }.bind(this));
    sibling = parts.join('\\n');
    if (sibling.length > 2000) sibling = sibling.substring(0, 2000) + '...';
  }
  return { outer: outer, sibling: sibling };
}`;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function responseValue(value: unknown): unknown {
  return asRecord(asRecord(value).result).value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

export class BrowserElementPicker {
  private busy = false;
  private enabled = false;

  constructor(private readonly options: BrowserElementPickerOptions) {}

  async setEnabled(enabled: boolean): Promise<boolean> {
    try {
      if (enabled) await this.enable();
      else await this.disable();
      return true;
    } catch {
      return false;
    }
  }

  handleDebuggerMessage(method: string, params: unknown): void {
    if (!(this.enabled && method === "Overlay.inspectNodeRequested")) return;
    const backendNodeId = asRecord(params).backendNodeId;
    if (typeof backendNodeId !== "number" || !Number.isSafeInteger(backendNodeId) || backendNodeId < 1) return;
    void this.select(backendNodeId);
  }

  dispose(): void {
    this.enabled = false;
  }

  private async enable(): Promise<void> {
    await this.options.sendCommand("DOM.enable");
    await this.options.sendCommand("Overlay.enable");
    await this.options.sendCommand("Overlay.setInspectMode", {
      mode: "searchForNode",
      highlightConfig: HIGHLIGHT_CONFIG,
    });
    this.enabled = true;
  }

  private async disable(): Promise<void> {
    this.enabled = false;
    try {
      await this.options.sendCommand("Overlay.hideHighlight");
      await this.options.sendCommand("Overlay.setInspectMode", { mode: "none", highlightConfig: {} });
      await this.options.sendCommand("Overlay.disable");
      await this.options.sendCommand("DOM.disable");
    } catch {
      // Disabling selection is best effort when a page or debugger is closing.
    }
  }

  private async select(backendNodeId: number): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const selection = await this.captureElementContext(backendNodeId);
      if (selection && this.enabled) this.options.onSelected(selection);
    } finally {
      this.busy = false;
    }
    if (this.enabled) await this.enable().catch(() => undefined);
  }

  private async captureElementContext(backendNodeId: number): Promise<BrowserElementSelection | null> {
    const send = this.options.sendCommand;
    try {
      await send("DOM.enable");
      await send("CSS.enable");
      await send("DOM.getDocument", { depth: 0 });

      const described = asRecord(await send("DOM.describeNode", { backendNodeId, depth: 0 }));
      const node = asRecord(described.node);
      const nodeId = node.nodeId;
      const rawAttributes = Array.isArray(node.attributes) ? node.attributes : [];
      const allAttributes: Record<string, string> = {};
      for (let index = 0; index < rawAttributes.length; index += 2) {
        const name = rawAttributes[index];
        const value = rawAttributes[index + 1];
        if (typeof name === "string" && typeof value === "string") allAttributes[name] = value;
      }
      const classes = (allAttributes.class ?? "").split(/\s+/).filter(Boolean);
      const attributes: Record<string, string> = {};
      for (const name of ATTRIBUTE_ALLOWLIST) {
        if (allAttributes[name]) attributes[name] = allAttributes[name];
      }

      const computedStyles: Record<string, string> = {};
      if (typeof nodeId === "number") {
        try {
          const response = asRecord(await send("CSS.getComputedStyleForNode", { nodeId }));
          const styles = Array.isArray(response.computedStyle) ? response.computedStyle : [];
          for (const name of STYLE_PROPERTIES) {
            const style = styles.find((entry) => asRecord(entry).name === name);
            const value = asRecord(style).value;
            if (typeof value === "string") computedStyles[name] = value;
          }
        } catch {
          // Computed styles are optional context.
        }
      }

      let boundingBox = { x: 0, y: 0, width: 0, height: 0 };
      try {
        const model = asRecord(asRecord(await send("DOM.getBoxModel", { backendNodeId })).model);
        const content = Array.isArray(model.content) ? model.content : [];
        if (content.length >= 6 && content.slice(0, 6).every((point) => typeof point === "number")) {
          const points = content as number[];
          boundingBox = {
            x: points[0] ?? 0,
            y: points[1] ?? 0,
            width: (points[2] ?? 0) - (points[0] ?? 0),
            height: (points[5] ?? 0) - (points[1] ?? 0),
          };
        }
      } catch {
        // A node without a box still produces useful DOM context.
      }

      let objectId: string | undefined;
      try {
        objectId = optionalString(asRecord(asRecord(await send("DOM.resolveNode", { backendNodeId })).object).objectId);
      } catch {
        // Runtime context is optional.
      }

      let reactComponent: string | undefined;
      let reactProps: Record<string, unknown> | undefined;
      let sourceFile: string | undefined;
      let innerText: string | undefined;
      let parentPath: string | undefined;
      let outerHTML: string | undefined;
      let siblingHTML: string | undefined;
      if (objectId) {
        try {
          const react = asRecord(
            responseValue(
              await send("Runtime.callFunctionOn", {
                objectId,
                functionDeclaration: REACT_CONTEXT_FUNCTION,
                returnByValue: true,
              }),
            ),
          );
          const name = optionalString(react.name);
          const ancestors = Array.isArray(react.ancestors)
            ? react.ancestors.filter((value): value is string => typeof value === "string")
            : [];
          reactComponent = name ? `${name}${ancestors.length ? ` (in ${ancestors.join(" > ")})` : ""}` : undefined;
          reactProps = react.props && typeof react.props === "object" ? (react.props as Record<string, unknown>) : undefined;
          sourceFile = optionalString(react.source);
        } catch {
          // React metadata is optional.
        }
        try {
          innerText = optionalString(
            responseValue(
              await send("Runtime.callFunctionOn", {
                objectId,
                functionDeclaration: INNER_TEXT_FUNCTION,
                returnByValue: true,
              }),
            ),
          );
          parentPath = optionalString(
            responseValue(
              await send("Runtime.callFunctionOn", {
                objectId,
                functionDeclaration: PARENT_PATH_FUNCTION,
                returnByValue: true,
              }),
            ),
          );
        } catch {
          // Text and parent path are optional.
        }
        try {
          const html = asRecord(
            responseValue(
              await send("Runtime.callFunctionOn", {
                objectId,
                functionDeclaration: HTML_CONTEXT_FUNCTION,
                returnByValue: true,
              }),
            ),
          );
          outerHTML = optionalString(html.outer);
          siblingHTML = optionalString(html.sibling);
        } catch {
          // Surrounding HTML is optional.
        }
      }

      const screenshot = await this.captureScreenshot(boundingBox);
      const href = allAttributes.href;
      const onclick = allAttributes.onclick;
      return {
        tagName: typeof node.nodeName === "string" ? node.nodeName.toLowerCase() : "",
        ...(allAttributes.id ? { id: allAttributes.id } : {}),
        classes,
        attributes,
        computedStyles,
        boundingBox,
        screenshot,
        ...(innerText ? { innerText } : {}),
        ...(parentPath ? { parentPath } : {}),
        ...(href ? { action: `navigates to: ${href}` } : onclick ? { action: `onclick: ${onclick.slice(0, 100)}` } : {}),
        ...(reactComponent ? { reactComponent } : {}),
        ...(reactProps ? { reactProps } : {}),
        ...(sourceFile ? { sourceFile } : {}),
        ...(outerHTML ? { outerHTML } : {}),
        ...(siblingHTML ? { siblingHTML } : {}),
      };
    } catch {
      return null;
    } finally {
      await send("CSS.disable").catch(() => undefined);
      await send("DOM.disable").catch(() => undefined);
    }
  }

  private async captureScreenshot(bounds: BrowserElementSelection["boundingBox"]): Promise<string> {
    if (this.options.isDestroyed()) return "";
    try {
      let image: NativeImage;
      if (bounds.width > 0 && bounds.height > 0 && bounds.x >= 0 && bounds.y >= 0) {
        const scrollResponse = asRecord(
          await this.options.sendCommand("Runtime.evaluate", {
            expression: "JSON.stringify({ x: window.scrollX, y: window.scrollY })",
            returnByValue: true,
          }),
        );
        const scroll = JSON.parse(String(asRecord(scrollResponse.result).value ?? "{}")) as { x?: number; y?: number };
        const padding = 80;
        image = await this.options.capturePage({
          x: Math.round(Math.max(0, bounds.x - (scroll.x ?? 0) - padding)),
          y: Math.round(Math.max(0, bounds.y - (scroll.y ?? 0) - padding)),
          width: Math.round(bounds.width + padding * 2),
          height: Math.round(bounds.height + padding * 2),
        });
      } else {
        image = await this.options.capturePage();
      }
      const size = image.getSize();
      if (size.width > 1200 || size.height > 1200) {
        const scale = Math.min(1200 / size.width, 1200 / size.height);
        image = image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) });
      }
      return image.toPNG().toString("base64");
    } catch {
      return "";
    }
  }
}
