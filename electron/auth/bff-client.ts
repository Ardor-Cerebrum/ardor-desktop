import { isAuth0AuthorizeUrlAllowed } from "./authorize.js";

const MAX_RESPONSE_BYTES = 65_536;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9_-]{16,4096}$/;
const IDENTITY_SESSION_PREFIX = "/identity-workspace-api/api/v1/auth/session";

export interface DesktopAuthUser {
  userId: string;
  email: string;
  role: "ADMIN" | "USER";
  workspaceId: string;
  isBetaUser: boolean;
  isDeveloper: boolean;
}

export interface DesktopMintedToken {
  internalToken: string;
  expiresIn: number;
  replacementSessionHandle: string;
  user: DesktopAuthUser;
}

export interface IdentityBffClientContract {
  start(redirectUri: string): Promise<{ authorizationUrl: string; transactionId: string }>;
  redeem(grant: string, previousSessionHandle?: string | null): Promise<{ sessionHandle: string }>;
  mint(sessionHandle: string): Promise<DesktopMintedToken>;
  logout(sessionHandle: string): Promise<number>;
  logoutAll(sessionHandle: string): Promise<number>;
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface IdentityBffClientOptions {
  authorizationDomain?: string;
  authorizationClientId?: string;
  requestTimeoutMs?: number;
}

export class DesktopAuthRequestError extends Error {
  readonly code = "DESKTOP_AUTH_REQUEST_FAILED";

  constructor() {
    super("desktop authentication request failed");
    this.name = "DesktopAuthRequestError";
  }
}

export class IdentityBffClient implements IdentityBffClientContract {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;

  constructor(
    baseUrl: string,
    private readonly fetch: Fetch = globalThis.fetch,
    private readonly options: IdentityBffClientOptions = {},
  ) {
    this.baseUrl = parseIdentityBffBaseUrl(baseUrl);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    if (!Number.isFinite(this.requestTimeoutMs) || this.requestTimeoutMs <= 0 || this.requestTimeoutMs > 60_000) {
      throw new DesktopAuthRequestError();
    }
  }

  async start(redirectUri: string): Promise<{ authorizationUrl: string; transactionId: string }> {
    if (redirectUri !== "http://127.0.0.1:17631/auth/callback") {
      throw new DesktopAuthRequestError();
    }
    const value = await this.request(`${IDENTITY_SESSION_PREFIX}/start`, {}, {
      client_kind: "desktop",
      redirect_uri: redirectUri,
    });
    const authorizationUrl = field(value, "authorization_url", 16, 8192);
    const transactionId = field(value, "transaction_id", 1, 512);
    validateAuthorizationUrl(
      authorizationUrl,
      this.options.authorizationDomain,
      this.options.authorizationClientId,
      redirectUri,
    );
    return { authorizationUrl, transactionId };
  }

  async redeem(grant: string, previousSessionHandle?: string | null): Promise<{ sessionHandle: string }> {
    assertOpaque(grant);
    if (previousSessionHandle) assertOpaque(previousSessionHandle);
    const value = await this.request(
      `${IDENTITY_SESSION_PREFIX}/desktop/redeem`,
      {
        "x-ardor-desktop-grant": grant,
        ...(previousSessionHandle ? { "x-ardor-session-handle": previousSessionHandle } : {}),
      },
      {},
    );
    const sessionHandle = field(value, "session_handle", 16, 4096);
    assertOpaque(sessionHandle);
    return { sessionHandle };
  }

  async mint(sessionHandle: string): Promise<DesktopMintedToken> {
    assertOpaque(sessionHandle);
    const value = await this.request(
      `${IDENTITY_SESSION_PREFIX}/token`,
      { "x-ardor-session-handle": sessionHandle },
      {},
    );
    const internalToken = field(value, "access_token", 16, 32_768);
    const replacementSessionHandle = field(value, "replacement_session_handle", 16, 4096);
    assertOpaque(replacementSessionHandle);
    if (value.token_type !== "Bearer" || !Number.isSafeInteger(value.expires_in) || Number(value.expires_in) <= 0 || Number(value.expires_in) > 3600) {
      throw new DesktopAuthRequestError();
    }
    const user = parseUser(value.user);
    return {
      internalToken,
      expiresIn: Number(value.expires_in),
      replacementSessionHandle,
      user,
    };
  }

  async logout(sessionHandle: string): Promise<number> {
    return this.revoke(`${IDENTITY_SESSION_PREFIX}/logout`, sessionHandle);
  }

  async logoutAll(sessionHandle: string): Promise<number> {
    return this.revoke(`${IDENTITY_SESSION_PREFIX}/logout-all`, sessionHandle);
  }

  private async revoke(path: string, sessionHandle: string): Promise<number> {
    assertOpaque(sessionHandle);
    const value = await this.request(path, { "x-ardor-session-handle": sessionHandle }, {});
    if (!Number.isSafeInteger(value.revoked_sessions) || Number(value.revoked_sessions) < 0) {
      throw new DesktopAuthRequestError();
    }
    return Number(value.revoked_sessions);
  }

  private async request(
    path: string,
    extraHeaders: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await abortable(
        this.fetch(`${this.baseUrl}${path}`, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { "content-type": "application/json", ...extraHeaders },
          body: JSON.stringify(body),
        }),
        controller.signal,
      );
      if (!response.ok || response.redirected) throw new Error("request rejected");
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (contentType !== "application/json" || !Number.isFinite(declaredLength) || declaredLength > MAX_RESPONSE_BYTES) {
        throw new Error("invalid response");
      }
      const text = await readBoundedText(response, controller.signal);
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid response");
      return parsed as Record<string, unknown>;
    } catch {
      throw new DesktopAuthRequestError();
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function readBoundedText(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    while (true) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) throw new Error("invalid response");
      chunks.push(result.value);
    }
  } catch (cause) {
    await reader.cancel().catch(() => undefined);
    throw cause;
  } finally {
    signal.removeEventListener("abort", cancelReader);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), totalBytes).toString("utf8");
}

export function parseIdentityBffBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("desktop identity BFF runtime config is invalid");
  }
  const isHttps = url.protocol === "https:";
  const isLoopbackHttp = url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost");
  if (
    (!isHttps && !isLoopbackHttp) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("desktop identity BFF runtime config is invalid");
  }
  return url.origin;
}

function validateAuthorizationUrl(
  value: string,
  authorizationDomain: string | undefined,
  authorizationClientId: string | undefined,
  redirectUri: string,
): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DesktopAuthRequestError();
  }
  const states = url.searchParams.getAll("state");
  const state = states.length === 1 ? states[0] : undefined;
  if (!state || state.length > 4096 || !authorizationDomain || !authorizationClientId || !isAuth0AuthorizeUrlAllowed(value, {
    domain: authorizationDomain,
    clientId: authorizationClientId,
    redirectUri,
    expectedState: state,
  })) {
    throw new DesktopAuthRequestError();
  }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("request aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new Error("request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

function assertOpaque(value: string): void {
  if (!OPAQUE_VALUE_PATTERN.test(value)) throw new DesktopAuthRequestError();
}

function field(value: Record<string, unknown>, name: string, min: number, max: number): string {
  const found = value[name];
  if (typeof found !== "string" || found.length < min || found.length > max) {
    throw new DesktopAuthRequestError();
  }
  return found;
}

function parseUser(value: unknown): DesktopAuthUser {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DesktopAuthRequestError();
  const user = value as Record<string, unknown>;
  const userId = field(user, "user_id", 1, 256);
  const email = field(user, "email", 3, 320);
  const roleValue = user.role;
  if (roleValue !== "ADMIN" && roleValue !== "USER") throw new DesktopAuthRequestError();
  const workspaceId = field(user, "workspace_id", 1, 256);
  if (typeof user.is_beta_user !== "boolean") throw new DesktopAuthRequestError();
  if (typeof user.is_developer !== "boolean") throw new DesktopAuthRequestError();
  return {
    userId,
    email,
    role: roleValue,
    workspaceId,
    isBetaUser: user.is_beta_user,
    isDeveloper: user.is_developer,
  };
}
