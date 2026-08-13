import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const DEV_CONFIG_PATHS = ['tauri.conf.json', 'tauri.stage1.conf.json'];

test('desktop development shells allow the Cloudflare Browser Run Live View frame', async () => {
  for (const path of DEV_CONFIG_PATHS) {
    const config = JSON.parse(await readFile(new URL(`../src-tauri/${path}`, import.meta.url), 'utf8'));
    assert.doesNotMatch(
      config.app.security.csp,
      /https:\/\/live\.browser\.run/,
      `${path} must not widen the packaged-app CSP for a development-only PoC`,
    );
    assert.match(
      config.app.security.devCsp,
      /frame-src[^;]*https:\/\/live\.browser\.run(?:[ ;]|$)/,
      `${path} must allow the Live View iframe`,
    );
  }
});
