import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { resolveSolutionsUiDir } from "./solutions-ui-path.mjs";

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

const UPDATER_SIGNING_ENV = [
  "TAURI_SIGNING_PRIVATE_KEY",
  "TAURI_SIGNING_PRIVATE_KEY_PATH",
  "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
  "TAURI_PRIVATE_KEY",
  "TAURI_PRIVATE_KEY_PATH",
  "TAURI_PRIVATE_KEY_PASSWORD",
];

const [channelArgument, commandArgument] = process.argv.slice(2);
const channel = parseChannel(channelArgument);
const command = parseCommand(commandArgument);

if (!channel || !command) {
  console.error("Usage: bun scripts/run-ui.mjs <stage1|prod> <build|dev|type-check>");
  process.exit(2);
}

const rootDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(rootDir, "..");
const solutionsUiDir = resolveSolutionsUiDir(repoDir);

if (command.kind === "type-check") {
  const result = runUiScript(command.script, withoutUpdaterSigningEnvironment(process.env));
  process.exit(result.status ?? 1);
}

const envFile = resolve(repoDir, "env", channel.envFileName);
const packageJson = JSON.parse(readFileSync(resolve(repoDir, "package.json"), "utf8"));

const fileEnv = existsSync(envFile) ? parseEnvFile(envFile) : {};
const env = withoutUpdaterSigningEnvironment({
  ...fileEnv,
  ...process.env,
  TAURI_BUILD_CHANNEL: channel.name,
  // The UI derives the desktop loopback redirect URI from this flag (see
  // solutions-ui getAuth0RedirectUri), so it must always win over inherited env.
  VITE_DESKTOP_BUILD_CHANNEL: channel.name,
});

delete env.VITE_SENTRY_DSN;
env.VITE_DESKTOP_APP_NAME ||= channel.appName;
env.VITE_DESKTOP_BUNDLE_ID ||= channel.bundleId;
env.VITE_DESKTOP_SHELL_VERSION ||= packageJson.version;

for (const key of OPTIONAL_PUBLIC_ENV) {
  if (env[key] === undefined) {
    env[key] = "";
  }
}

const missingRequired = REQUIRED_ENV.filter((key) => !env[key] || env[key].includes("replace-with-"));
if (missingRequired.length > 0) {
  const prodHint =
    channel.name === "prod"
      ? "\nCopy env/prod.env.example to env/prod.env and fill the production Auth0/client values, or export the missing variables."
      : "";

  console.error(
    `Missing required ${channel.name} desktop UI env: ${missingRequired.join(", ")}.${prodHint}`,
  );
  process.exit(1);
}

const result = runUiScript(command.script, env);

process.exit(result.status ?? 1);

function parseChannel(value) {
  switch (value) {
    case "stage1":
      return {
        appName: "Ardor Dev",
        bundleId: "cloud.ardor.desktop.stage1",
        envFileName: "stage1.env",
        name: "stage1",
      };
    case "prod":
      return {
        appName: "Ardor",
        bundleId: "cloud.ardor.desktop",
        envFileName: "prod.env",
        name: "prod",
      };
    default:
      return null;
  }
}

function parseCommand(value) {
  switch (value) {
    case "build":
      return { kind: "runtime", script: "build:tauri" };
    case "dev":
      return { kind: "runtime", script: "dev" };
    case "type-check":
      return { kind: "type-check", script: "type-check" };
    default:
      return null;
  }
}

function runUiScript(script, environment) {
  return spawnSync("bun", ["run", script], {
    // ARDOR_SOLUTIONS_UI_DIR intentionally selects a local UI checkout. Its caller
    // already has equivalent filesystem access, and release CI never derives it
    // from workflow inputs or pull-request data.
    // codeql[js/path-injection]
    cwd: solutionsUiDir,
    env: environment,
    stdio: "inherit",
  });
}

function withoutUpdaterSigningEnvironment(environment) {
  const result = { ...environment };
  for (const key of UPDATER_SIGNING_ENV) {
    delete result[key];
  }
  return result;
}

function parseEnvFile(path) {
  const entries = new Map();
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
    entries.set(key, unquote(value));
  }

  return Object.fromEntries(entries);
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
