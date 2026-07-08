import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Generates Tauri updater manifests (one per build channel) from the release
// assets produced by CI. The app fetches these from the GitHub release via the
// stable `releases/latest/download/<manifest>` URL configured in
// `plugins.updater.endpoints`.

const [, , assetsDir = "release-assets"] = process.argv;

const tag = process.env.RELEASE_TAG;
if (!tag) {
  throw new Error("RELEASE_TAG is not set");
}

const repo = process.env.GITHUB_REPOSITORY ?? "Ardor-Cerebrum/ardor-desktop";
const version = tag.replace(/^v/, "");
const baseUrl = `https://github.com/${repo}/releases/download/${tag}`;

const channels = [
  { prefix: "Ardor", manifest: "latest.json" },
  { prefix: "Ardor-Dev", manifest: "latest-stage1.json" },
];

for (const { prefix, manifest } of channels) {
  const assets = {
    "darwin-aarch64": `${prefix}-${tag}-macos-aarch64.app.tar.gz`,
    "windows-x86_64": `${prefix}-${tag}-windows-x64-setup.exe`,
  };

  const platforms = {};
  for (const [platform, asset] of Object.entries(assets)) {
    const signaturePath = join(assetsDir, `${asset}.sig`);
    if (!existsSync(join(assetsDir, asset))) {
      throw new Error(`Missing updater asset for ${platform}: ${asset}`);
    }
    if (!existsSync(signaturePath)) {
      throw new Error(`Missing updater signature for ${platform}: ${asset}.sig`);
    }

    platforms[platform] = {
      signature: readFileSync(signaturePath, "utf8").trim(),
      url: `${baseUrl}/${asset}`,
    };
  }

  const manifestPath = join(assetsDir, manifest);
  const body = {
    version,
    pub_date: new Date().toISOString(),
    platforms,
  };
  writeFileSync(manifestPath, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`Wrote ${manifestPath}`);
}
