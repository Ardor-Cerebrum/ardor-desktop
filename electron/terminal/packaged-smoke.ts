import { randomUUID } from "node:crypto";

import type {
  TerminalClientEvent,
  TerminalClientOpenRequest,
  TerminalClientResponse,
  TerminalClientSnapshot,
} from "./client-contract.js";

export interface PackagedTerminalSmokeGateway {
  close(ownerId: number, terminalId: string, generation: number): Promise<TerminalClientResponse>;
  listProfiles(): Promise<TerminalClientResponse>;
  onEvent(listener: (ownerId: number, event: TerminalClientEvent) => void): () => void;
  open(ownerId: number, terminalId: string, request: TerminalClientOpenRequest): Promise<TerminalClientResponse>;
  resize(
    ownerId: number,
    terminalId: string,
    generation: number,
    cols: number,
    rows: number,
  ): Promise<TerminalClientResponse>;
  write(ownerId: number, terminalId: string, generation: number, data: string): Promise<TerminalClientResponse>;
}

export interface PackagedTerminalSmokeSupervisor {
  shutdown(): Promise<void>;
}

export interface PackagedTerminalSmokeOptions {
  readonly gateway: PackagedTerminalSmokeGateway;
  readonly ownerId: number;
  readonly platform: NodeJS.Platform;
  readonly supervisor: PackagedTerminalSmokeSupervisor;
  readonly terminalId?: string;
  readonly timeoutMs?: number;
}

const SMOKE_COLS = 80;
const SMOKE_ROWS = 24;
const SMOKE_RESIZED_COLS = 100;
const SMOKE_RESIZED_ROWS = 30;
const DEFAULT_TIMEOUT_MS = 15_000;

function requireSuccess(response: TerminalClientResponse, operation: string): void {
  if (!response.ok) {
    throw new Error(`Packaged terminal smoke ${operation} failed: ${response.error.message}`);
  }
}

function requireSnapshot(response: TerminalClientResponse): TerminalClientSnapshot {
  if (!response.ok || (response.requestType !== "open" && response.requestType !== "restart")) {
    throw new Error(response.ok ? "Packaged terminal smoke did not receive a snapshot." : response.error.message);
  }
  return response.snapshot;
}

function requireDefaultProfile(response: TerminalClientResponse) {
  if (!response.ok || response.requestType !== "listProfiles") {
    throw new Error(response.ok ? "Packaged terminal smoke did not receive shell profiles." : response.error.message);
  }
  const profileId = response.catalog.defaultProfileId;
  if (!profileId || !response.catalog.profiles.some((profile) => profile.id === profileId)) {
    throw new Error("Packaged terminal smoke did not discover a default shell profile.");
  }
  return profileId;
}

function createMarker(): string {
  return `ARDOR_TERMINAL_SMOKE_${randomUUID().replaceAll("-", "").slice(0, 16).toUpperCase()}`;
}

function createCommand(platform: NodeJS.Platform, marker: string): string {
  return platform === "win32" ? `echo ${marker}\r` : `printf '${marker}\\n'\r`;
}

export async function runPackagedTerminalSmoke(options: PackagedTerminalSmokeOptions): Promise<void> {
  const terminalId = options.terminalId ?? "terminal:packaged-smoke";
  const marker = createMarker();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let opened: TerminalClientSnapshot | undefined;
  let closed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveMarker!: () => void;
  let rejectMarker!: (error: Error) => void;
  const markerOutput = new Promise<void>((resolve, reject) => {
    resolveMarker = resolve;
    rejectMarker = reject;
  });
  const unsubscribe = options.gateway.onEvent((ownerId, event) => {
    if (
      ownerId === options.ownerId &&
      event.terminalId === terminalId &&
      event.type === "data" &&
      event.data.includes(marker)
    ) {
      resolveMarker();
    }
  });
  timeout = setTimeout(() => rejectMarker(new Error(`Timed out waiting for terminal marker ${marker}.`)), timeoutMs);

  try {
    const profileId = requireDefaultProfile(await options.gateway.listProfiles());
    opened = requireSnapshot(await options.gateway.open(options.ownerId, terminalId, {
      cols: SMOKE_COLS,
      profileId,
      rows: SMOKE_ROWS,
    }));
    requireSuccess(
      await options.gateway.resize(
        options.ownerId,
        terminalId,
        opened.generation,
        SMOKE_RESIZED_COLS,
        SMOKE_RESIZED_ROWS,
      ),
      "resize",
    );
    requireSuccess(
      await options.gateway.write(options.ownerId, terminalId, opened.generation, createCommand(options.platform, marker)),
      "write",
    );
    await markerOutput;
    requireSuccess(await options.gateway.close(options.ownerId, terminalId, opened.generation), "close");
    closed = true;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    unsubscribe();
    if (opened && !closed) {
      await options.gateway.close(options.ownerId, terminalId, opened.generation).catch(() => undefined);
    }
    await options.supervisor.shutdown();
  }
}
