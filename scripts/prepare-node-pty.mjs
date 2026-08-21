import { chmod } from "node:fs/promises";
import { resolve } from "node:path";

const DARWIN_SPAWN_HELPERS = [
  "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
  "node_modules/node-pty/prebuilds/darwin-x64/spawn-helper",
];

for (const helper of DARWIN_SPAWN_HELPERS) {
  try {
    await chmod(resolve(helper), 0o755);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
