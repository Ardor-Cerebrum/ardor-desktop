import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tauriConfig = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);
const migrationConfig = JSON.parse(
  readFileSync(new URL("../src-tauri/tauri.migration.conf.json", import.meta.url), "utf8"),
);
const rust = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const html = readFileSync(new URL("../migration-ui/index.html", import.meta.url), "utf8");
const javascript = readFileSync(new URL("../migration-ui/migration.js", import.meta.url), "utf8");
const releaseWorkflow = readFileSync(
  new URL("../.github/workflows/release.yml", import.meta.url),
  "utf8",
);

test("the final Tauri build is a local, fixed-destination migration app", () => {
  assert.equal(tauriConfig.version, packageJson.version);
  assert.equal(migrationConfig.build.beforeBuildCommand, "");
  assert.equal(migrationConfig.build.frontendDist, "../migration-ui");
  assert.equal(migrationConfig.app.withGlobalTauri, true);
  assert.match(packageJson.scripts["tauri:build:migration"], /--features migration/);
  assert.match(
    packageJson.scripts["tauri:build:migration"],
    /tauri\.updater-artifacts\.conf\.json/,
  );
  assert.match(rust, /fn open_electron_download\(\) -> Result<\(\), String>/);
  assert.match(
    rust,
    /open_external_url\(\s*"https:\/\/github\.com\/Ardor-Cerebrum\/ardor-desktop\/releases",?\s*\)/,
  );
  assert.doesNotMatch(rust, /fn open_electron_download\([^)]*(?:String|&str)/);
  assert.match(html, /A new Ardor app is ready/);
  assert.match(javascript, /invoke\("open_electron_download"\)/);
  assert.equal(
    releaseWorkflow.match(/run: bun run tauri:build:migration -- --bundles (?:app|nsis)/g)
      ?.length,
    2,
  );
  assert.doesNotMatch(
    releaseWorkflow,
    /run: bun run tauri:build:prod -- --bundles (?:app|nsis)/,
  );
});
