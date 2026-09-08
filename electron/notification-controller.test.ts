import { describe, expect, mock, test } from "bun:test";

import type { DesktopNotificationPayload } from "./bridge-contract";
import {
  DesktopNotificationController,
  parseDesktopNotificationPayload,
  type NativeNotification,
  type NativeNotificationFactory,
} from "./notification-controller";

const validPayload: DesktopNotificationPayload = {
  body: "The agent has finished the task.",
  kind: "success",
  sessionId: "session-1",
  tag: "ardor-agent:session-1:run-1",
  title: "Building Tic Tac Toe",
};

class FakeNotification implements NativeNotification {
  readonly handlers = new Map<string, () => void>();
  readonly close = mock(() => this.emit("close"));
  readonly show = mock(() => {
    if (this.autoShow) this.emit("show");
  });

  constructor(private readonly autoShow = true) {}

  on(event: "click" | "close" | "failed" | "show", handler: () => void): this {
    this.handlers.set(event, handler);
    return this;
  }

  emit(event: "click" | "close" | "failed" | "show"): void {
    this.handlers.get(event)?.();
  }
}

function createHarness(
  options: {
    autoShow?: boolean;
    deliveryTimeoutMs?: number;
    isSupported?: boolean;
    permission?: "granted" | "denied";
  } = {},
) {
  const notifications: FakeNotification[] = [];
  const notificationOptions: Array<{ body: string; silent: boolean; title: string }> = [];
  const createNotification: NativeNotificationFactory = mock((nativeOptions) => {
    notificationOptions.push(nativeOptions);
    const notification = new FakeNotification(options.autoShow);
    notifications.push(notification);
    return notification;
  });
  const focusWindow = mock(() => undefined);
  const emitOpened = mock((_sessionId: string) => undefined);
  const controller = new DesktopNotificationController({
    createNotification,
    deliveryTimeoutMs: options.deliveryTimeoutMs,
    emitOpened,
    focusWindow,
    getPermission: () => options.permission ?? "granted",
    isSupported: () => options.isSupported ?? true,
  });

  return {
    controller,
    createNotification,
    emitOpened,
    focusWindow,
    notificationOptions,
    notifications,
  };
}

describe("parseDesktopNotificationPayload", () => {
  test("accepts the bounded notification contract", () => {
    expect(parseDesktopNotificationPayload(validPayload)).toEqual(validPayload);
  });

  test.each([
    ["unknown property", { ...validPayload, extra: true }],
    ["unknown kind", { ...validPayload, kind: "error" }],
    ["unexpected body", { ...validPayload, body: "Click here to continue." }],
    ["blank session id", { ...validPayload, sessionId: "   " }],
    ["oversized session id", { ...validPayload, sessionId: "s".repeat(257) }],
    ["oversized tag", { ...validPayload, tag: "t".repeat(513) }],
    ["oversized title", { ...validPayload, title: "t".repeat(161) }],
    ["oversized body", { ...validPayload, body: "b".repeat(241) }],
    ["malformed Unicode", { ...validPayload, body: "\ud800" }],
  ])("rejects %s", (_name, value) => {
    expect(() => parseDesktopNotificationPayload(value)).toThrow("desktop notification payload is invalid");
  });

  test("accepts the inclusive length boundary for renderer-controlled fields", () => {
    const result = parseDesktopNotificationPayload({
      ...validPayload,
      sessionId: "s".repeat(256),
      tag: "t".repeat(512),
      title: "t".repeat(160),
    });

    expect(result.body).toBe(validPayload.body);
    expect(result.sessionId).toHaveLength(256);
    expect(result.tag).toHaveLength(512);
    expect(result.title).toHaveLength(160);
  });
});

describe("DesktopNotificationController", () => {
  test("reports unsupported and denied native delivery", () => {
    expect(createHarness({ isSupported: false }).controller.getStatus()).toEqual({
      message: "System notifications are not supported on this device.",
      status: "unsupported",
    });
    expect(createHarness({ permission: "denied" }).controller.getStatus()).toEqual({
      message: "System notifications are disabled in operating system settings.",
      status: "denied",
    });
  });

  test("constructs and confirms a silent native notification", async () => {
    const harness = createHarness();

    await expect(harness.controller.show(validPayload)).resolves.toEqual({ status: "shown" });
    expect(harness.notificationOptions).toEqual([
      {
        body: validPayload.body,
        silent: true,
        title: validPayload.title,
      },
    ]);
    expect(harness.notifications[0]?.show).toHaveBeenCalledTimes(1);
  });

  test("replaces an active notification with the same tag", async () => {
    const harness = createHarness();

    await harness.controller.show(validPayload);
    await harness.controller.show(validPayload);

    expect(harness.notifications[0]?.close).toHaveBeenCalledTimes(1);
    expect(harness.notifications).toHaveLength(2);
  });

  test("removes closed and failed notifications from active state", async () => {
    const harness = createHarness();

    await harness.controller.show(validPayload);
    harness.notifications[0]?.emit("failed");
    await harness.controller.show(validPayload);

    expect(harness.notifications[0]?.close).not.toHaveBeenCalled();
  });

  test("focuses the window, emits the originating session, and releases the notification on click", async () => {
    const harness = createHarness();

    await harness.controller.show(validPayload);
    harness.notifications[0]?.emit("click");
    await harness.controller.show(validPayload);

    expect(harness.focusWindow).toHaveBeenCalledTimes(1);
    expect(harness.emitOpened).toHaveBeenCalledWith(validPayload.sessionId);
    expect(harness.notifications[0]?.close).not.toHaveBeenCalled();
  });

  test("returns structured failures for invalid payloads and native exceptions", async () => {
    const invalidHarness = createHarness();
    const throwingHarness = createHarness();
    throwingHarness.createNotification.mockImplementation(() => {
      throw new Error("native failure");
    });

    await expect(invalidHarness.controller.show({ ...validPayload, body: "" })).resolves.toEqual({
      code: "invalid_payload",
      message: "System notification request was invalid.",
      status: "failed",
    });
    await expect(throwingHarness.controller.show(validPayload)).resolves.toEqual({
      code: "native_failure",
      message: "System notification could not be shown.",
      status: "failed",
    });
  });

  test("reports an asynchronous native failure instead of a false success", async () => {
    const harness = createHarness({ autoShow: false });

    const result = harness.controller.show(validPayload);
    harness.notifications[0]?.emit("failed");

    await expect(result).resolves.toEqual({
      code: "native_failure",
      message: "System notification could not be shown.",
      status: "failed",
    });
  });

  test("reports a delivery timeout when the operating system does not acknowledge the notification", async () => {
    const harness = createHarness({ autoShow: false, deliveryTimeoutMs: 1 });

    await expect(harness.controller.show(validPayload)).resolves.toEqual({
      code: "delivery_timeout",
      message: "System notification delivery was not confirmed.",
      status: "failed",
    });
  });

  test("bounds active native notifications", async () => {
    const harness = createHarness();

    for (let index = 0; index <= 32; index += 1) {
      await harness.controller.show({ ...validPayload, tag: `${validPayload.tag}:${index}` });
    }

    expect(harness.notifications[0]?.close).toHaveBeenCalledTimes(1);
  });

  test("disposes every active notification", async () => {
    const harness = createHarness();

    await harness.controller.show(validPayload);
    await harness.controller.show({ ...validPayload, tag: `${validPayload.tag}:second` });
    harness.controller.dispose();

    expect(harness.notifications[0]?.close).toHaveBeenCalledTimes(1);
    expect(harness.notifications[1]?.close).toHaveBeenCalledTimes(1);
  });
});
