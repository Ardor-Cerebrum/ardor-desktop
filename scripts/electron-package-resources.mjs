import { cp, readdir, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

/**
 * Electron Packager places each `extraResource` directory under the platform's
 * resources directory using the source directory basename. The shell has a
 * stable lookup path, resources/dist, so normalize an arbitrary configured
 * source name after the package copy has completed.
 */
export async function normalizeUiResourceDirectory(packageRoot, sourceResourceName, platform = process.platform) {
  if (!sourceResourceName || sourceResourceName !== basename(sourceResourceName)) {
    throw new Error("Electron UI resource name must be a single directory name");
  }

  const resourcesRoot =
    platform === "darwin" ? await resolveMacResourcesRoot(packageRoot) : resolve(packageRoot, "resources");
  const sourceDirectory = resolve(resourcesRoot, sourceResourceName);
  const destinationDirectory = resolve(resourcesRoot, "dist");
  if (sourceDirectory === destinationDirectory) {
    return;
  }

  await rm(destinationDirectory, { recursive: true, force: true });
  await cp(sourceDirectory, destinationDirectory, { recursive: true });
  await rm(sourceDirectory, { recursive: true, force: true });
}

async function resolveMacResourcesRoot(packageRoot) {
  const entries = await readdir(packageRoot, { withFileTypes: true });
  const appBundle = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (!appBundle) {
    throw new Error(`Electron macOS app bundle is missing under ${packageRoot}`);
  }
  return resolve(packageRoot, appBundle.name, "Contents", "Resources");
}
