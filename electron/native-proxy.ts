const NATIVE_ROUTE_PREFIX = '/cerebrum-native';
const STAGE_API_ORIGIN = 'https://azure-stage.dev.ardor.cloud';
const PRODUCTION_API_ORIGIN = 'https://console.ardor.cloud';

export function isNativeProxyPath(pathname: string): boolean {
  return pathname === NATIVE_ROUTE_PREFIX || pathname.startsWith(`${NATIVE_ROUTE_PREFIX}/`);
}

export function resolveNativeApiOrigin(apiUrl: string | undefined, channel: string): string {
  const fallback = channel === 'prod' ? PRODUCTION_API_ORIGIN : STAGE_API_ORIGIN;
  const value = apiUrl?.trim() || fallback;
  const url = new URL(value);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Invalid native API URL: ${value}`);
  }
  return url.origin;
}

export function buildNativeProxyUrl(requestUrl: string | URL, apiOrigin: string): string {
  const request = new URL(requestUrl);
  const target = new URL(apiOrigin);
  target.pathname = request.pathname;
  target.search = request.search;
  return target.toString();
}

export function sanitizeNativeProxyHeaders(input: HeadersInit, origin?: string): Headers {
  const headers = new Headers(input);
  for (const name of ['accept-encoding', 'cookie', 'host', 'origin', 'referer']) {
    headers.delete(name);
  }
  if (origin) {
    headers.set('origin', origin);
  }
  return headers;
}
