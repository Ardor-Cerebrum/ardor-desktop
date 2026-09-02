export interface DesktopRuntimeConfig {
  auth0Domain: string;
  auth0ClientId: string;
  identityBffBaseUrl: string;
  autoUpdateEnabled?: boolean;
  windowsUpdateFeedUrl?: string;
  windowsUpdatePublicKey?: string;
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
  const identityBffBaseUrl = parseIdentityBffBaseUrl(config.identityBffBaseUrl);

  const autoUpdateEnabled = config.autoUpdateEnabled;
  if (autoUpdateEnabled !== undefined && typeof autoUpdateEnabled !== "boolean") {
    throw new Error("desktop auto-update runtime config is invalid");
  }

  const windowsUpdateFeedUrl = optionalTrimmedString(config.windowsUpdateFeedUrl);
  const windowsUpdatePublicKey = optionalTrimmedString(config.windowsUpdatePublicKey);
  if ((windowsUpdateFeedUrl && !windowsUpdatePublicKey) || (!windowsUpdateFeedUrl && windowsUpdatePublicKey)) {
    throw new Error("desktop Windows updater runtime config is incomplete");
  }

  return {
    auth0Domain,
    auth0ClientId,
    identityBffBaseUrl,
    ...(typeof autoUpdateEnabled === "boolean" ? { autoUpdateEnabled } : {}),
    ...(windowsUpdateFeedUrl ? { windowsUpdateFeedUrl } : {}),
    ...(windowsUpdatePublicKey ? { windowsUpdatePublicKey } : {}),
  };
}

export function resolveDesktopRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DesktopRuntimeConfig {
  return parseDesktopRuntimeConfig({
    auth0Domain: environment.ARDOR_AUTH0_DOMAIN ?? environment.VITE_AUTH0_DOMAIN,
    auth0ClientId: environment.ARDOR_AUTH0_CLIENT_ID ?? environment.VITE_AUTH0_CLIENT_ID,
    identityBffBaseUrl: environment.ARDOR_IDENTITY_BFF_BASE_URL,
  });
}

function parseIdentityBffBaseUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("desktop identity BFF runtime config is invalid");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("desktop identity BFF runtime config is invalid");
  }
  const isHttps = url.protocol === "https:";
  const isLoopbackHttp = url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if ((!isHttps && !isLoopbackHttp) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("desktop identity BFF runtime config is invalid");
  }
  return url.origin;
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("desktop updater runtime config is invalid");
  }
  return value.trim();
}
