import type {
  DesktopNotificationPayload,
  DesktopNotificationResult,
  DesktopNotificationStatus,
} from "./bridge-contract.js";
import { isWellFormedString } from "./terminal/protocol.js";

const PAYLOAD_KEYS = ["body", "kind", "sessionId", "tag", "title"] as const;
const PAYLOAD_KEY_SET = new Set<string>(PAYLOAD_KEYS);
const INVALID_PAYLOAD_MESSAGE = "desktop notification payload is invalid";

const LIMITS = Object.freeze({
  body: 240,
  sessionId: 256,
  tag: 512,
  title: 160,
});

export interface NativeNotification {
  close(): void;
  on(event: "click" | "close" | "failed", handler: () => void): this;
  show(): void;
}

export type NativeNotificationFactory = (options: {
  body: string;
  silent: boolean;
  title: string;
}) => NativeNotification;

interface DesktopNotificationControllerOptions {
  createNotification: NativeNotificationFactory;
  emitOpened(sessionId: string): void;
  focusWindow(): void;
  getPermission(): "default" | "denied" | "granted";
  isSupported(): boolean;
}

export class DesktopNotificationController {
  private readonly active = new Map<string, NativeNotification>();

  constructor(private readonly options: DesktopNotificationControllerOptions) {}

  getStatus(): DesktopNotificationStatus {
    if (!this.options.isSupported()) {
      return {
        message: "System notifications are not supported on this device.",
        status: "unsupported",
      };
    }
    if (this.options.getPermission() === "denied") {
      return {
        message: "System notifications are disabled in operating system settings.",
        status: "denied",
      };
    }
    return { status: "ready" };
  }

  show(value: unknown): DesktopNotificationResult {
    const status = this.getStatus();
    if (status.status !== "ready") {
      return status;
    }

    let payload: DesktopNotificationPayload;
    try {
      payload = parseDesktopNotificationPayload(value);
    } catch {
      return {
        message: "System notification request was invalid.",
        status: "failed",
      };
    }

    try {
      this.active.get(payload.tag)?.close();

      const notification = this.options.createNotification({
        body: payload.body,
        silent: true,
        title: payload.title,
      });
      const remove = () => {
        if (this.active.get(payload.tag) === notification) {
          this.active.delete(payload.tag);
        }
      };
      notification.on("click", () => {
        this.options.focusWindow();
        this.options.emitOpened(payload.sessionId);
      });
      notification.on("close", remove);
      notification.on("failed", remove);
      this.active.set(payload.tag, notification);
      notification.show();
      return { status: "shown" };
    } catch {
      this.active.delete(payload.tag);
      return {
        message: "System notification could not be shown.",
        status: "failed",
      };
    }
  }

  dispose(): void {
    const notifications = [...this.active.values()];
    this.active.clear();
    for (const notification of notifications) {
      try {
        notification.close();
      } catch {
        // Native notifications are best-effort during application shutdown.
      }
    }
  }
}

export function parseDesktopNotificationPayload(value: unknown): DesktopNotificationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(INVALID_PAYLOAD_MESSAGE);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== PAYLOAD_KEYS.length || keys.some((key) => !PAYLOAD_KEY_SET.has(key))) {
    throw new Error(INVALID_PAYLOAD_MESSAGE);
  }
  if (record.kind !== "success" && record.kind !== "action_required") {
    throw new Error(INVALID_PAYLOAD_MESSAGE);
  }
  if (
    !isBoundedText(record.body, LIMITS.body) ||
    !isBoundedText(record.sessionId, LIMITS.sessionId) ||
    !isBoundedText(record.tag, LIMITS.tag) ||
    !isBoundedText(record.title, LIMITS.title)
  ) {
    throw new Error(INVALID_PAYLOAD_MESSAGE);
  }

  return {
    body: record.body,
    kind: record.kind,
    sessionId: record.sessionId,
    tag: record.tag,
    title: record.title,
  };
}

function isBoundedText(value: unknown, maximumCodeUnits: number): value is string {
  return (
    isWellFormedString(value) &&
    value.trim().length > 0 &&
    value.length <= maximumCodeUnits
  );
}
