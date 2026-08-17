import { resolve } from "node:path";

export function resolveSolutionsUiDir(repoDir, environment = process.env) {
  return environment.ARDOR_SOLUTIONS_UI_DIR
    ? resolve(repoDir, environment.ARDOR_SOLUTIONS_UI_DIR)
    : resolve(repoDir, "../solutions-ui");
}
