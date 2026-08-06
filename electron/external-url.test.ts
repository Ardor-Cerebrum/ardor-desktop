import { expect, test } from 'bun:test';

import { openExternalUrl } from './external-url';

test('accepts HTTP(S) and delegates exactly once', async () => {
  const opened: string[] = [];

  await openExternalUrl('https://example.com/path', async (url) => {
    opened.push(url);
  });

  expect(opened).toEqual(['https://example.com/path']);
});

test.each(['javascript:alert(1)', 'data:text/html,unsafe', 'file:///tmp/file', '', null, 42])(
  'rejects non-HTTP(S) value %p before delegation', async (value) => {
    const opened: string[] = [];

    await expect(
      openExternalUrl(value, async (url) => {
        opened.push(url);
      }),
    ).rejects.toThrow('external URL is not allowed');
    expect(opened).toEqual([]);
  },
);
