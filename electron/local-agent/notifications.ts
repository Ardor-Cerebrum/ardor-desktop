import { createHash } from "node:crypto";

import type { DesktopNotificationKind, DesktopNotificationPayload } from "../bridge-contract.js";
import type { LocalAgentRuntimeScope } from "./protocol.js";

const MAX_LOCAL_CHAT_ROUTE_LENGTH = 16_384;

export interface LocalAgentNotificationContext {
  readonly cwd: string;
  readonly generation: number;
  readonly runtimeId: string;
  readonly scope: LocalAgentRuntimeScope;
  readonly threadId: string;
}

export interface LocalAgentNotification {
  readonly payload: DesktopNotificationPayload;
  readonly route: string;
}

export function createLocalAgentChatNotification(
  context: LocalAgentNotificationContext,
  kind: DesktopNotificationKind,
): LocalAgentNotification | null {
  if (!isSafeIdentity(context.runtimeId, 256) || !isSafeIdentity(context.threadId, 128) ||
      !isSafeIdentity(context.scope.accountId, 512) || !isSafeIdentity(context.scope.workspaceId, 512) ||
      !isSafeIdentity(context.cwd, 4096) || !Number.isSafeInteger(context.generation) || context.generation < 0) {
    return null;
  }
  const routeTarget = {
    environment: "local",
    runtimeId: context.runtimeId,
    accountId: context.scope.accountId,
    workspaceId: context.scope.workspaceId,
    threadId: context.threadId,
    cwd: context.cwd,
  };
  const route = `local~${encodeURIComponent(JSON.stringify(routeTarget))}`;
  if (route.length > MAX_LOCAL_CHAT_ROUTE_LENGTH) return null;

  const sessionId = `ardor-local:${createHash("sha256").update(route).digest("hex")}`;
  const body = kind === "action_required"
    ? "The agent is waiting for your response."
    : "The agent has finished the task.";
  return {
    route,
    payload: {
      body,
      kind,
      sessionId,
      tag: `${sessionId}:${kind}`,
      title: kind === "action_required" ? "Local agent needs your attention" : "Local agent finished a task",
    },
  };
}

function isSafeIdentity(value: string, maximumLength: number): boolean {
  return value.length > 0 && value.trim().length > 0 && value.length <= maximumLength &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32);
}
