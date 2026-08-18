import type {
  TerminalBrokerErrorCode,
  TerminalEvent,
  TerminalReplayChunk,
  TerminalRequestType,
} from "./protocol.js";
import type { TerminalShellProfileCatalog, TerminalShellProfileId } from "./shell-profile.js";

export type TerminalClientProfileCatalog = TerminalShellProfileCatalog;

export interface TerminalClientOpenRequest {
  readonly cols: number;
  readonly cwd?: string;
  readonly profileId?: TerminalShellProfileId;
  readonly rows: number;
}

export interface TerminalClientRestartRequest {
  readonly cols?: number;
  readonly cwd?: string;
  readonly profileId?: TerminalShellProfileId;
  readonly rows?: number;
}

export interface TerminalClientSnapshot {
  readonly cols: number;
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly generation: number;
  readonly profileId: TerminalShellProfileId;
  readonly replay: readonly TerminalReplayChunk[];
  readonly rows: number;
  readonly sequence: number;
  readonly shell: string;
  readonly status: "exited" | "running";
  readonly terminalId: string;
  readonly truncated: boolean;
}

export type TerminalClientEvent =
  | Omit<Extract<TerminalEvent, { type: "data" }>, "ownerId">
  | Omit<Extract<TerminalEvent, { type: "exit" }>, "ownerId">
  | Omit<Extract<TerminalEvent, { type: "service-lost" }>, "ownerId">;

export type TerminalClientResponse =
  | {
      readonly error: { readonly code: TerminalBrokerErrorCode; readonly message: string };
      readonly ok: false;
      readonly requestType: TerminalRequestType;
    }
  | {
      readonly ok: true;
      readonly requestType: "open" | "restart";
      readonly snapshot: TerminalClientSnapshot;
    }
  | {
      readonly ok: true;
      readonly requestType: "listProfiles";
      readonly catalog: TerminalClientProfileCatalog;
    }
  | {
      readonly ok: true;
      readonly requestType: Exclude<TerminalRequestType, "listProfiles" | "open" | "restart">;
    };
