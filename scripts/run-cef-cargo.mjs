import { spawnSync } from "node:child_process";
import { withCefBuildEnv } from "./cef-build-env.mjs";

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("Usage: bun scripts/run-cef-cargo.mjs <cargo command> [args...]");
  process.exit(2);
}

const result = spawnSync("cargo", [command, ...args], {
  env: withCefBuildEnv(),
  stdio: "inherit",
});

if (result.error) {
  console.error(`Failed to start cargo: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
