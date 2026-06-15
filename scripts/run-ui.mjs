import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const CHANNELS = new Set(["stage1", "prod"]);
const COMMANDS = new Set(["build", "dev"]);

const REQUIRED_ENV = [
  "VITE_API_URL",
  "VITE_ARTIFACT_API_URL",
  "VITE_AUTH0_DOMAIN",
  "VITE_AUTH0_CLIENT_ID",
];

const OPTIONAL_PUBLIC_ENV = [
  "VITE_AMPLITUDE_API_KEY",
  "VITE_DESKTOP_SENTRY_DSN",
  "VITE_STRIPE_PRICING_TABLE_ID",
  "VITE_STRIPE_PUBLISHABLE_KEY",
];

const CHANNEL_METADATA = {
  stage1: {
    appName: "Ardor Dev",
    bundleId: "cloud.ardor.desktop.stage1",
  },
  prod: {
    appName: "Ardor",
    bundleId: "cloud.ardor.desktop",
  },
};

const [channel, command] = process.argv.slice(2);

if (!CHANNELS.has(channel) || !COMMANDS.has(command)) {
  console.error("Usage: bun scripts/run-ui.mjs <stage1|prod> <build|dev>");
  process.exit(2);
}

const rootDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(rootDir, "..");
const solutionsUiDir = resolve(repoDir, "../solutions-ui");
const envFile = resolve(repoDir, "env", `${channel}.env`);
const packageJson = JSON.parse(readFileSync(resolve(repoDir, "package.json"), "utf8"));

const fileEnv = existsSync(envFile) ? parseEnvFile(envFile) : {};
const env = {
  ...fileEnv,
  ...process.env,
  TAURI_BUILD_CHANNEL: channel,
  VITE_DESKTOP_BUILD_CHANNEL: channel,
};
const channelMetadata = CHANNEL_METADATA[channel];

delete env.VITE_SENTRY_DSN;
setDefault(env, "VITE_DESKTOP_APP_NAME", channelMetadata.appName);
setDefault(env, "VITE_DESKTOP_BUNDLE_ID", channelMetadata.bundleId);
setDefault(env, "VITE_DESKTOP_SHELL_VERSION", packageJson.version);

for (const key of OPTIONAL_PUBLIC_ENV) {
  if (env[key] === undefined) {
    env[key] = "";
  }
}

const missingRequired = REQUIRED_ENV.filter((key) => !env[key] || env[key].includes("replace-with-"));
if (missingRequired.length > 0) {
  const prodHint =
    channel === "prod"
      ? "\nCopy env/prod.env.example to env/prod.env and fill the production Auth0/client values, or export the missing variables."
      : "";

  console.error(
    `Missing required ${channel} desktop UI env: ${missingRequired.join(", ")}.${prodHint}`,
  );
  process.exit(1);
}

const result = spawnSync("bun", ["run", command === "build" ? "build:tauri" : "dev"], {
  cwd: solutionsUiDir,
  env,
  stdio: "inherit",
});

process.exit(result.status ?? 1);

function setDefault(env, key, value) {
  if (!env[key]) {
    env[key] = value;
  }
}

function parseEnvFile(path) {
  const result = {};
  const contents = readFileSync(path, "utf8");

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separatorIndex = normalized.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    const value = normalized.slice(separatorIndex + 1).trim();
    result[key] = unquote(value);
  }

  return result;
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
