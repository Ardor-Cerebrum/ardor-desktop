export function rewriteAuth0TokenCorsHeaders(
  responseHeaders: Record<string, string[]> | undefined,
  shellOrigin: string,
): Record<string, string[]> {
  const headers = Object.fromEntries(
    Object.entries(responseHeaders ?? {}).filter(([name]) => !name.toLowerCase().startsWith("access-control-")),
  );

  return {
    ...headers,
    "Access-Control-Allow-Origin": [shellOrigin],
    "Access-Control-Allow-Credentials": ["true"],
    "Access-Control-Allow-Headers": ["Content-Type, Authorization, Auth0-Client, X-Requested-With"],
    "Access-Control-Allow-Methods": ["POST, OPTIONS"],
  };
}
