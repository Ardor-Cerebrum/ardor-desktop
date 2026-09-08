import { describe, expect, mock, test } from "bun:test";

import type { ArdorDesktopBridge, DesktopNotificationPayload } from "./bridge-contract";

let exposedBridge: ArdorDesktopBridge | undefined;
const invoke = mock(async (_channel: string, ..._args: unknown[]) => undefined);
const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
const on = mock((channel: string, listener: (_event: unknown, payload: unknown) => void) => {
  listeners.set(channel, listener);
});
const removeListener = mock(
  (channel: string, listener: (_event: unknown, payload: unknown) => void) => {
    if (listeners.get(channel) === listener) {
      listeners.delete(channel);
    }
  },
);

mock.module("electron", () => ({
  contextBridge: {
    exposeInMainWorld: mock((_name: string, bridge: ArdorDesktopBridge) => {
      exposedBridge = bridge;
    }),
  },
  ipcRenderer: { invoke, on, removeListener },
}));

await import("./preload");

const payload: DesktopNotificationPayload = {
  body: "The agent has finished the task.",
  kind: "success",
  sessionId: "session-1",
  tag: "ardor-agent:session-1:run-1",
  title: "Building Tic Tac Toe",
};

describe("notification preload bridge", () => {
  test("exposes a frozen notification capability with bounded request channels", async () => {
    if (!exposedBridge) {
      throw new Error("preload bridge was not exposed");
    }

    expect(Object.isFrozen(exposedBridge.notifications)).toBe(true);
    await exposedBridge.notifications.getStatus();
    await exposedBridge.notifications.show(payload);

    expect(invoke).toHaveBeenCalledWith("desktop:notifications:get-status");
    expect(invoke).toHaveBeenCalledWith("desktop:notifications:show", payload);
  });

  test("subscribes and unsubscribes only the opened event", async () => {
    if (!exposedBridge) {
      throw new Error("preload bridge was not exposed");
    }
    const handler = mock((_sessionId: string) => undefined);

    const unlisten = await exposedBridge.notifications.onOpened(handler);
    listeners.get("desktop:notifications:opened")?.({}, "session-1");
    expect(handler).toHaveBeenCalledWith("session-1");

    unlisten();
    expect(listeners.has("desktop:notifications:opened")).toBe(false);
    expect(removeListener).toHaveBeenCalledTimes(1);
  });
});
