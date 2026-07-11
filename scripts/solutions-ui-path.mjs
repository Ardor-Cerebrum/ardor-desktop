import { relative, resolve, sep } from "node:path";

export function resolveSolutionsUiDir(repoDir, environment = process.env) {
  return environment.ARDOR_SOLUTIONS_UI_DIR
    ? resolve(repoDir, environment.ARDOR_SOLUTIONS_UI_DIR)
    : resolve(repoDir, "../solutions-ui");
}

export function resolveTauriFrontendDist(repoDir, environment = process.env) {
  const srcTauriDir = resolve(repoDir, "src-tauri");
  const frontendDist = resolve(resolveSolutionsUiDir(repoDir, environment), "dist");

  return relative(srcTauriDir, frontendDist).split(sep).join("/");
}
