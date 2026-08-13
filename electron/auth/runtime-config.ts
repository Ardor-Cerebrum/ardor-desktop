export interface DesktopRuntimeConfig {
  auth0Domain: string;
  auth0ClientId: string;
  browserWebAuthnKeychainAccessGroup?: string;
}

const WEBAUTHN_KEYCHAIN_ACCESS_GROUP_PATTERN = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+\.webauthn$/;

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

  const rawWebAuthnGroup = config.browserWebAuthnKeychainAccessGroup;
  const browserWebAuthnKeychainAccessGroup =
    typeof rawWebAuthnGroup === "string" && rawWebAuthnGroup.trim() ? rawWebAuthnGroup.trim() : undefined;
  if (
    browserWebAuthnKeychainAccessGroup &&
    !WEBAUTHN_KEYCHAIN_ACCESS_GROUP_PATTERN.test(browserWebAuthnKeychainAccessGroup)
  ) {
    throw new Error("desktop Browser WebAuthn keychain access group is invalid");
  }

  return {
    auth0Domain,
    auth0ClientId,
    ...(browserWebAuthnKeychainAccessGroup ? { browserWebAuthnKeychainAccessGroup } : {}),
  };
}

export function resolveDesktopRuntimeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): DesktopRuntimeConfig {
  return parseDesktopRuntimeConfig({
    auth0Domain: environment.ARDOR_AUTH0_DOMAIN ?? environment.VITE_AUTH0_DOMAIN,
    auth0ClientId: environment.ARDOR_AUTH0_CLIENT_ID ?? environment.VITE_AUTH0_CLIENT_ID,
    browserWebAuthnKeychainAccessGroup: environment.ARDOR_BROWSER_WEBAUTHN_KEYCHAIN_ACCESS_GROUP,
  });
}
