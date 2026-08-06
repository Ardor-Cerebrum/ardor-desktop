export interface Auth0LogoutUrlOptions {
  domain: string;
  allowedDomain?: string;
  clientId?: string;
  returnTo: string;
}

function normalizeAuth0Domain(value: string, label: string): string {
  const candidate = value.includes("://") ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error(`Auth0 domain is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.pathname !== "/") {
    throw new Error(`${label} is invalid`);
  }
  return url.hostname.toLowerCase();
}

function validateLogoutReturnUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Auth0 logout return URL is invalid");
  }
  if (
    url.protocol !== "ardor:" ||
    url.hostname !== "app" ||
    url.username ||
    url.password ||
    url.port ||
    !["", "/", "/index.html"].includes(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error("Auth0 logout return URL is not trusted");
  }
  return url.toString();
}

export function buildAuth0LogoutUrl(options: Auth0LogoutUrlOptions): string {
  const domain = normalizeAuth0Domain(options.domain, "Auth0 domain");
  if (options.allowedDomain && domain !== normalizeAuth0Domain(options.allowedDomain, "Auth0 allowed domain")) {
    throw new Error("Auth0 domain is not configured");
  }
  const returnTo = validateLogoutReturnUrl(options.returnTo);
  const query = new URLSearchParams();
  if (options.clientId) {
    query.append("client_id", options.clientId);
  }
  query.append("returnTo", returnTo);
  return `https://${domain}/v2/logout?${query.toString()}`;
}
