import { expect, test } from 'bun:test';

import { openExternalUrl } from './external-url';

test('accepts a public HTTPS URL and delegates exactly once', async () => {
  const opened: string[] = [];

  await openExternalUrl('https://example.com/path', async (url) => {
    opened.push(url);
  });

  expect(opened).toEqual(['https://example.com/path']);
});

test.each([
  'http://example.com',
  'https://user:password@example.com',
  'https://localhost',
  'https://service.local',
  'https://127.0.0.1',
  'https://10.0.0.1',
  'https://172.16.0.1',
  'https://192.168.0.1',
  'https://169.254.0.1',
  'https://100.64.0.1',
  'https://[::1]',
  'https://[fc00::1]',
  'https://[fe90::1]',
  'https://[::ffff:127.0.0.1]',
  'javascript:alert(1)',
  'data:text/html,unsafe',
  'file:///tmp/file',
  '',
  null,
  42,
])('rejects non-public external URL %p before delegation', async (value) => {
    const opened: string[] = [];

    await expect(
      openExternalUrl(value, async (url) => {
        opened.push(url);
      }),
    ).rejects.toThrow('external URL is not allowed');
    expect(opened).toEqual([]);
  });
