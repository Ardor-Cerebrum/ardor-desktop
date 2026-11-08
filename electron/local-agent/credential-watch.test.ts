import { describe, expect, test } from "bun:test";
import { startCredentialWatch } from "./credential-watch.js";

describe("local runtime credential lifetime", () => {
  test("stops on failed authority once, even with no model request or UI interaction", async () => {
    const revoked = Promise.withResolvers<void>();
    let checks = 0;
    const stop = startCredentialWatch({
      intervalMs: 1,
      verify: async () => { checks += 1; throw new Error("revoked"); },
      onRevoked: () => revoked.resolve(),
    });
    try { await revoked.promise; expect(checks).toBe(1); } finally { stop(); }
  });

  test("does not overlap checks or revive a disposed runtime after a delayed result", async () => {
    const started = Promise.withResolvers<void>();
    const delayed = Promise.withResolvers<void>();
    let checks = 0;
    let revoked = false;
    const stop = startCredentialWatch({
      intervalMs: 1,
      verify: async () => { checks += 1; started.resolve(); await delayed.promise; },
      onRevoked: () => { revoked = true; },
    });
    await started.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(checks).toBe(1);
    stop();
    delayed.reject(new Error("late denial"));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(checks).toBe(1);
    expect(revoked).toBe(false);
  });
});
