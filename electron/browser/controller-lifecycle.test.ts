import { describe, expect, test } from "bun:test";

import { BrowserControllerLifecycle } from "./controller-lifecycle";

describe("browser controller window lifecycle", () => {
  test("disposes a closed-window controller and creates a fresh controller on activation", () => {
    const disposed: string[] = [];
    let created = 0;
    const lifecycle = new BrowserControllerLifecycle<{ id: string }, { id: string; dispose(): void }>((window) => {
      created += 1;
      return {
        id: `${window.id}-${created}`,
        dispose: () => disposed.push(`${window.id}-${created}`),
      };
    });
    const firstWindow = { id: "first" };
    const secondWindow = { id: "second" };

    const firstController = lifecycle.attach(firstWindow);
    expect(lifecycle.attach(firstWindow)).toBe(firstController);
    lifecycle.onClosed(firstWindow);
    expect(disposed).toEqual(["first-1"]);

    const secondController = lifecycle.attach(secondWindow);
    expect(secondController).not.toBe(firstController);
    expect(secondController.id).toBe("second-2");
    expect(lifecycle.controller).toBe(secondController);
  });
});
