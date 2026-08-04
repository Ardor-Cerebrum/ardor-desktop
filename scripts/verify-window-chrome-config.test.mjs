import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const CONFIG_PATHS = [
  'src-tauri/tauri.conf.json',
  'src-tauri/tauri.stage1.conf.json',
  'src-tauri/tauri.prod.conf.json',
];

test('all desktop channels share the native macOS overlay contract', async () => {
  for (const path of CONFIG_PATHS) {
    const config = JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'));
    const [window] = config.app.windows;

    assert.equal(window.decorations, true, `${path} must retain native window decorations`);
    assert.equal(window.titleBarStyle, 'Overlay', `${path} must overlay the macOS title bar`);
    assert.equal(window.hiddenTitle, true, `${path} must hide the native window title`);
    assert.equal(
      window.trafficLightPosition,
      undefined,
      `${path} must leave traffic-light layout to the precise AppKit hook`,
    );
  }
});
