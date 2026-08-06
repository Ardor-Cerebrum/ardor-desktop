export function isAllowedExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function openExternalUrl(
  value: unknown,
  openExternal: (url: string) => Promise<void>,
): Promise<void> {
  if (!isAllowedExternalUrl(value)) {
    throw new Error('external URL is not allowed');
  }

  await openExternal(value);
}
