export interface DesktopRuntimeConfig {
  auth0Domain: string;
  auth0ClientId: string;
  autoUpdateEnabled?: boolean;
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

  return {
    auth0Domain,
    auth0ClientId,
    ...(typeof autoUpdateEnabled === "boolean" ? { autoUpdateEnabled } : {}),
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
