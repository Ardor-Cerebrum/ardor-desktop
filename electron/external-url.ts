import { isPublicBrowserUrl } from './browser/security.js';

export function isAllowedExternalUrl(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isPublicBrowserUrl(value);
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
