import { describe, expect, test } from "bun:test";

import { createLocalAgentChatNotification } from "./notifications.js";

const context = {
  cwd: "C:\\Users\\someone\\Projects\\café",
  generation: 4,
  runtimeId: "runtime-4",
  scope: { accountId: "auth0|user-1", workspaceId: "workspace-2" },
  threadId: "thread-5",
};

describe("createLocalAgentChatNotification", () => {
  test("creates a bounded approval notification that routes back to the same local chat scope", () => {
    const result = createLocalAgentChatNotification(context, "action_required");

    expect(result).not.toBeNull();
    expect(result?.payload).toMatchObject({
      body: "The agent is waiting for your response.",
      kind: "action_required",
      title: "Local agent needs your attention",
    });
    expect(result?.payload.sessionId.length).toBeLessThanOrEqual(256);
    expect(result?.route.startsWith("local~")).toBe(true);
    expect(JSON.parse(decodeURIComponent(result?.route.slice("local~".length) ?? ""))).toEqual({
      environment: "local",
      runtimeId: context.runtimeId,
      accountId: context.scope.accountId,
      workspaceId: context.scope.workspaceId,
      threadId: context.threadId,
      cwd: context.cwd,
    });
  });

  test("uses the fixed completion copy and rejects a route that exceeds the renderer bound", () => {
    const result = createLocalAgentChatNotification(context, "success");
    expect(result?.payload).toMatchObject({
      body: "The agent has finished the task.",
      kind: "success",
      title: "Local agent finished a task",
    });

    expect(createLocalAgentChatNotification({ ...context, cwd: `C:\\${"文".repeat(1900)}` }, "success"))
      .toBeNull();
  });
});
