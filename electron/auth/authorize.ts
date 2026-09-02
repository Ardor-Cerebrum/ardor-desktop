import { DESKTOP_AUTH_CALLBACK_URL } from "./callback-store.js";

export interface Auth0AuthorizeUrlOptions {
  domain: string;
  clientId?: string;
  redirectUri?: string;
  expectedState?: string;
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
 * registered for this desktop. State and PKCE parameters are required and
 * validated before the main process opens the external browser.
 */
export function isAuth0AuthorizeUrlAllowed(value: unknown, options: Auth0AuthorizeUrlOptions): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const authDomain = normalizeAuth0Domain(options.domain);
  const redirectUri = options.redirectUri ?? DESKTOP_AUTH_CALLBACK_URL;
  if (!authDomain || !options.clientId?.trim() || !redirectUri || !options.expectedState) {
    return false;
  }

  try {
    const url = new URL(value);
    const redirectUris = url.searchParams.getAll("redirect_uri");
    const clientIds = url.searchParams.getAll("client_id");
    const states = url.searchParams.getAll("state");
    const responseTypes = url.searchParams.getAll("response_type");
    const codeChallenges = url.searchParams.getAll("code_challenge");
    const codeChallengeMethods = url.searchParams.getAll("code_challenge_method");
    const nonces = url.searchParams.getAll("nonce");
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
      clientIds[0] === options.clientId.trim() &&
      states.length === 1 &&
      states[0] === options.expectedState &&
      responseTypes.length === 1 &&
      responseTypes[0] === "code" &&
      codeChallenges.length === 1 &&
      /^[A-Za-z0-9_-]{43,128}$/.test(codeChallenges[0] ?? "") &&
      codeChallengeMethods.length === 1 &&
      codeChallengeMethods[0] === "S256" &&
      nonces.length === 1 &&
      /^[A-Za-z0-9_-]{1,512}$/.test(nonces[0] ?? "")
    );
  } catch {
    return false;
  }
}
