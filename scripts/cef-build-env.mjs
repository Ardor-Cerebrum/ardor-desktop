import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultBuildDir = resolve(repoDir, "src-tauri");
const DEFAULT_CEF_PATH = join(defaultBuildDir, "cef-cache");
const DEFAULT_CARGO_TARGET_DIR = join(defaultBuildDir, "target");

export function resolveCefBuildPaths(env = process.env) {
  return {
    cefPath: env.CEF_PATH?.trim() || DEFAULT_CEF_PATH,
    targetDir: env.CARGO_TARGET_DIR?.trim() || DEFAULT_CARGO_TARGET_DIR,
  };
}

export function withCefBuildEnv(env = process.env) {
  const paths = resolveCefBuildPaths(env);
  return {
    ...env,
    CEF_PATH: paths.cefPath,
    CARGO_TARGET_DIR: paths.targetDir,
    CARGO_INCREMENTAL: env.CARGO_INCREMENTAL?.trim() || "0",
  };
}
