import { DESKTOP_AUTH_CALLBACK_URL } from "./callback-store.js";

export interface Auth0AuthorizeUrlOptions {
  domain: string;
  clientId?: string;
  redirectUri?: string;
}

function normalizeAuth0Domain(value: string): string | null {
  const candidate = value.includes("://") ? value : `https://${value}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/") {
      return null;
    }
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Restrict the native Auth0 launch to the exact tenant, client, and callback
 * registered for this desktop. OAuth parameters such as state and PKCE values
 * remain caller-controlled, but redirect targets cannot be changed by the UI.
 */
export function isAuth0AuthorizeUrlAllowed(value: unknown, options: Auth0AuthorizeUrlOptions): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const authDomain = normalizeAuth0Domain(options.domain);
  const redirectUri = options.redirectUri ?? DESKTOP_AUTH_CALLBACK_URL;
  if (!authDomain || !options.clientId?.trim() || !redirectUri) {
    return false;
  }

  try {
    const url = new URL(value);
    const redirectUris = url.searchParams.getAll("redirect_uri");
    const clientIds = url.searchParams.getAll("client_id");
    return (
      url.protocol === "https:" &&
      url.hostname === authDomain &&
      !url.username &&
      !url.password &&
      !url.port &&
      url.pathname === "/authorize" &&
      !url.hash &&
      redirectUris.length === 1 &&
      redirectUris[0] === redirectUri &&
      clientIds.length === 1 &&
      clientIds[0] === options.clientId.trim()
    );
  } catch {
    return false;
  }
}
