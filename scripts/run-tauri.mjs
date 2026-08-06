import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withCefBuildEnv } from "./cef-build-env.mjs";
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

// ARDOR_SOLUTIONS_UI_DIR intentionally selects a local UI checkout. Its caller
// already has equivalent filesystem access, and release CI never derives it
// from workflow inputs or pull-request data.
if (!existsSync(solutionsUiPackage) && !existsSync(solutionsUiEntry)) {
  console.error(
    `solutions-ui input has neither package.json nor a built dist/index.html: ${solutionsUiDir}`,
  );
  process.exit(1);
}

const env = withCefBuildEnv({
  ...process.env,
  ARDOR_SOLUTIONS_UI_DIR: solutionsUiDir,
});
const bundlesIndex = forwardedArgs.findIndex((argument) => argument === '--bundles');
const inlineBundles = forwardedArgs.find((argument) => argument.startsWith('--bundles='));
const requestedBundles = (
  bundlesIndex >= 0 ? forwardedArgs[bundlesIndex + 1] : inlineBundles?.slice('--bundles='.length)
)
  ?.split(',')
  .map((bundle) => bundle.trim().toLowerCase())
  .filter(Boolean);
const windowsBundleTypes = requestedBundles?.filter((bundle) => bundle === 'nsis' || bundle === 'msi');
if (windowsBundleTypes?.length === 1) {
  env.ARDOR_WINDOWS_BUNDLE_TYPE = windowsBundleTypes[0];
} else if (windowsBundleTypes && windowsBundleTypes.length > 1) {
  console.error('CEF bootstrap builds must select exactly one Windows installer type.');
  process.exit(2);
}
const args = ["tauri", command];
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

const result = spawnSync("cargo", args, {
  cwd: repoDir,
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
