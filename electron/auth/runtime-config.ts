export interface DesktopRuntimeConfig {
  auth0Domain: string;
  auth0ClientId: string;
  autoUpdateEnabled?: boolean;
  windowsUpdateFeedUrl?: string;
  windowsUpdatePublicKey?: string;
  cerebrumSourceCommit?: string;
  cerebrumManifestSha256?: string;
}

export function parseDesktopRuntimeConfig(value: unknown): DesktopRuntimeConfig {
  if (!value || typeof value !== "object") {
    throw new Error("desktop Auth0 runtime config is incomplete");
  }

  const config = value as Record<string, unknown>;
  const auth0Domain = typeof config.auth0Domain === "string" ? config.auth0Domain.trim() : "";
  const auth0ClientId = typeof config.auth0ClientId === "string" ? config.auth0ClientId.trim() : "";

  if (!auth0Domain || !auth0ClientId) {
    throw new Error("desktop Auth0 runtime config is incomplete");
  }

  const autoUpdateEnabled = config.autoUpdateEnabled;
  if (autoUpdateEnabled !== undefined && typeof autoUpdateEnabled !== "boolean") {
    throw new Error("desktop auto-update runtime config is invalid");
  }

  const windowsUpdateFeedUrl = optionalTrimmedString(config.windowsUpdateFeedUrl);
  const windowsUpdatePublicKey = optionalTrimmedString(config.windowsUpdatePublicKey);
  if ((windowsUpdateFeedUrl && !windowsUpdatePublicKey) || (!windowsUpdateFeedUrl && windowsUpdatePublicKey)) {
    throw new Error("desktop Windows updater runtime config is incomplete");
  }
  const cerebrumSourceCommit = optionalTrimmedString(config.cerebrumSourceCommit);
  if (cerebrumSourceCommit && !/^[0-9a-f]{40}$/.test(cerebrumSourceCommit)) {
    throw new Error("Cerebrum source pin is invalid");
  }
  const cerebrumManifestSha256 = optionalTrimmedString(config.cerebrumManifestSha256);
  if (cerebrumManifestSha256 && !/^[0-9a-f]{64}$/.test(cerebrumManifestSha256)) {
    throw new Error("Cerebrum manifest pin is invalid");
  }
  if (Boolean(cerebrumSourceCommit) !== Boolean(cerebrumManifestSha256)) {
    throw new Error("Cerebrum runtime pin is incomplete");
  }

  return {
    auth0Domain,
    auth0ClientId,
    ...(typeof autoUpdateEnabled === "boolean" ? { autoUpdateEnabled } : {}),
    ...(windowsUpdateFeedUrl ? { windowsUpdateFeedUrl } : {}),
    ...(windowsUpdatePublicKey ? { windowsUpdatePublicKey } : {}),
    ...(cerebrumSourceCommit ? { cerebrumSourceCommit } : {}),
    ...(cerebrumManifestSha256 ? { cerebrumManifestSha256 } : {}),
  };
}

export function resolveDesktopRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DesktopRuntimeConfig {
  return parseDesktopRuntimeConfig({
    auth0Domain: environment.ARDOR_AUTH0_DOMAIN ?? environment.VITE_AUTH0_DOMAIN,
    auth0ClientId: environment.ARDOR_AUTH0_CLIENT_ID ?? environment.VITE_AUTH0_CLIENT_ID,
    cerebrumSourceCommit: environment.ARDOR_CEREBRUM_SOURCE_SHA,
    cerebrumManifestSha256: environment.ARDOR_CEREBRUM_MANIFEST_SHA256,
  });
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("desktop updater runtime config is invalid");
  }
  return value.trim();
}
