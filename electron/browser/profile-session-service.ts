import { createHash } from "node:crypto";

import type { BrowserProfileScope, BrowserSiteData, BrowserStorageMode } from "../bridge-contract";
import type { BrowserProfileStore } from "./profile-store";

const LEGACY_BROWSER_PARTITION = "persist:ardor-browser";

interface BrowserProfileCookie {
  domain?: string;
}

export interface BrowserProfileSession {
  cookies: {
    flushStore(): Promise<void>;
    get(filter: Record<string, never>): Promise<BrowserProfileCookie[]>;
  };
  clearAuthCache(): Promise<void>;
  clearData(): Promise<void>;
  flushStorageData(): void;
}

export type BrowserProfileSessionProvider = (partition: string) => BrowserProfileSession;

function scopeHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export class BrowserProfileSessionService {
  private readonly runtimePartitions = new Set<string>([LEGACY_BROWSER_PARTITION]);

  constructor(
    private readonly getSession: BrowserProfileSessionProvider,
    private readonly profileStore: BrowserProfileStore,
  ) {}

  partitionFor(scope: BrowserProfileScope): string {
    const workspaceHash = scopeHash(scope.workspaceId);
    const storageMode = this.profileStore.snapshot().storageMode;
    let partition: string;
    switch (storageMode) {
      case "none":
        partition = `ardor-browser-${workspaceHash}`;
        break;
      case "shared":
        partition = `persist:ardor-browser-${workspaceHash}`;
        break;
      case "session":
        partition = `persist:ardor-browser-session-${scopeHash(`${scope.workspaceId}\0${scope.sessionId}`)}`;
        break;
    }
    this.runtimePartitions.add(partition);
    if (partition.startsWith("persist:")) {
      this.profileStore.trackPartition(partition);
    }
    return partition;
  }

  async setStorageMode(storageMode: BrowserStorageMode) {
    const snapshot = this.profileStore.updateStorageMode(storageMode);
    if (storageMode === "none") {
      await this.clearSiteData();
    }
    return snapshot;
  }

  async listSiteData(): Promise<BrowserSiteData[]> {
    const counts = new Map<string, number>();
    for (const partition of this.partitions()) {
      let cookies: BrowserProfileCookie[];
      try {
        cookies = await this.getSession(partition).cookies.get({});
      } catch {
        continue;
      }
      for (const cookie of cookies) {
        const domain = (cookie.domain ?? "").replace(/^\./, "").toLowerCase();
        if (domain) {
          counts.set(domain, (counts.get(domain) ?? 0) + 1);
        }
      }
    }
    return [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([domain, cookieCount]) => ({ domain, cookieCount }));
  }

  async clearSiteData(): Promise<boolean> {
    const results = await Promise.all(
      this.partitions().map(async (partition) => {
        try {
          const browserSession = this.getSession(partition);
          await browserSession.clearData();
          await browserSession.clearAuthCache();
          return true;
        } catch {
          return false;
        }
      }),
    );
    return results.every(Boolean);
  }

  async flushPersistentData(): Promise<void> {
    await Promise.all(
      this.partitions()
        .filter((partition) => partition.startsWith("persist:"))
        .map(async (partition) => {
          const browserSession = this.getSession(partition);
          browserSession.flushStorageData();
          await browserSession.cookies.flushStore();
        }),
    );
  }

  private partitions(): string[] {
    return [...new Set([...this.profileStore.trackedPartitions(), ...this.runtimePartitions])];
  }
}
