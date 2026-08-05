import { cp, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

/**
 * Electron Packager places each `extraResource` directory under resources
 * using the source directory basename. The shell has a stable lookup path,
 * resources/dist, so normalize an arbitrary configured source name after the
 * package copy has completed.
 */
export async function normalizeUiResourceDirectory(packageRoot, sourceResourceName) {
  if (!sourceResourceName || sourceResourceName !== basename(sourceResourceName)) {
    throw new Error("Electron UI resource name must be a single directory name");
  }

  const resourcesRoot = resolve(packageRoot, "resources");
  const sourceDirectory = resolve(resourcesRoot, sourceResourceName);
  const destinationDirectory = resolve(resourcesRoot, "dist");
  if (sourceDirectory === destinationDirectory) {
    return;
  }

  await rm(destinationDirectory, { recursive: true, force: true });
  await cp(sourceDirectory, destinationDirectory, { recursive: true });
  await rm(sourceDirectory, { recursive: true, force: true });
}
