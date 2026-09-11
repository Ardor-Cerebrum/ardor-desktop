export interface DesktopRuntimeConfig {
  auth0Domain: string;
  auth0ClientId: string;
  autoUpdateEnabled?: boolean;
  windowsUpdateFeedUrl?: string;
  windowsUpdatePublicKey?: string;
}

export interface ArdorProviderRuntimeConfig {
  baseUrl: string;
  artifactBaseUrl: string;
  auth0Domain: string;
  auth0ClientId: string;
}

export const DEFAULT_ARDOR_PROVIDER_RUNTIME_CONFIG: Readonly<ArdorProviderRuntimeConfig> = Object.freeze({
  baseUrl: "https://console.ardor.cloud",
  artifactBaseUrl: "https://artifact.ardor.build/artifact-api",
  auth0Domain: "auth.ardor.cloud",
  auth0ClientId: "oQDEHomiDbo3Gut2B6tTf46jRcdtvn2s",
});

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

  return {
    auth0Domain,
    auth0ClientId,
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
  });
}

export function resolveArdorProviderRuntimeConfig(value?: unknown): ArdorProviderRuntimeConfig {
  const root = asRecord(value);
  const config = asRecord(root?.config);
  const providers = asRecord(config?.providers);
  const ardor = asRecord(providers?.ardor);

  return {
    baseUrl: parseHttpBaseUrl(
      ardor?.base_url,
      DEFAULT_ARDOR_PROVIDER_RUNTIME_CONFIG.baseUrl,
      "providers.ardor.base_url",
      false,
    ),
    artifactBaseUrl: parseHttpBaseUrl(
      ardor?.artifact_base_url,
      DEFAULT_ARDOR_PROVIDER_RUNTIME_CONFIG.artifactBaseUrl,
      "providers.ardor.artifact_base_url",
      true,
    ),
    auth0Domain: parseAuth0Domain(
      ardor?.auth0_domain,
      DEFAULT_ARDOR_PROVIDER_RUNTIME_CONFIG.auth0Domain,
    ),
    auth0ClientId: parseNonEmptyString(
      ardor?.auth0_client_id,
      DEFAULT_ARDOR_PROVIDER_RUNTIME_CONFIG.auth0ClientId,
      "providers.ardor.auth0_client_id",
    ),
  };
}

function optionalTrimmedString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("desktop updater runtime config is invalid");
  }
  return value.trim();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseNonEmptyString(value: unknown, fallback: string, label: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !value.trim() || value.length > 2_048) {
    throw new Error(`${label} is invalid`);
  }
  return value.trim();
}

function parseHttpBaseUrl(
  value: unknown,
  fallback: string,
  label: string,
  allowPath: boolean,
): string {
  const input = parseNonEmptyString(value, fallback, label);
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback))
    || url.username
    || url.password
    || url.search
    || url.hash
    || (!allowPath && url.pathname !== "/")
  ) {
    throw new Error(`${label} must be public HTTPS or loopback HTTP without credentials, query, or fragment`);
  }
  return url.toString().replace(/\/$/, "");
}

function parseAuth0Domain(value: unknown, fallback: string): string {
  const domain = parseNonEmptyString(value, fallback, "providers.ardor.auth0_domain");
  let url: URL;
  try {
    url = new URL(`https://${domain}`);
  } catch {
    throw new Error("providers.ardor.auth0_domain is invalid");
  }
  if (url.host !== domain || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error("providers.ardor.auth0_domain must contain only a hostname and optional port");
  }
  return domain;
}
