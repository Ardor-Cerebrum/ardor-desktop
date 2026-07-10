import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveSolutionsUiDir, resolveTauriFrontendDist } from "./solutions-ui-path.mjs";

const COMMANDS = new Set(["build", "dev"]);
const CHANNEL_CONFIGS = {
  default: null,
  prod: "src-tauri/tauri.prod.conf.json",
  stage1: "src-tauri/tauri.stage1.conf.json",
};

const [command, channel, ...forwardedArgs] = process.argv.slice(2);

if (!COMMANDS.has(command) || !(channel in CHANNEL_CONFIGS)) {
  console.error("Usage: bun scripts/run-tauri.mjs <build|dev> <default|stage1|prod> [tauri args...]");
  process.exit(2);
}

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const solutionsUiDir = resolveSolutionsUiDir(repoDir);
const solutionsUiPackage = resolve(solutionsUiDir, "package.json");
const solutionsUiEntry = resolve(solutionsUiDir, "dist/index.html");

if (!existsSync(solutionsUiPackage) && !existsSync(solutionsUiEntry)) {
  console.error(
    `solutions-ui input has neither package.json nor a built dist/index.html: ${solutionsUiDir}`,
  );
  process.exit(1);
}

const env = {
  ...process.env,
  ARDOR_SOLUTIONS_UI_DIR: solutionsUiDir,
};
const args = ["--bun", "@tauri-apps/cli@2.11.2", command];
const channelConfig = CHANNEL_CONFIGS[channel];

if (channelConfig) {
  args.push("--config", channelConfig);
}

args.push(...forwardedArgs);
args.push(
  "--config",
  JSON.stringify({
    build: {
      frontendDist: resolveTauriFrontendDist(repoDir, env),
    },
  }),
);

const result = spawnSync("bunx", args, {
  cwd: repoDir,
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
