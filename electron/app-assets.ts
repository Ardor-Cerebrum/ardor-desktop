import { existsSync, realpathSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";

export function resolveAppAssetPath(root: string, pathname: string): string | null {
  if (pathname.includes("\0")) {
    return null;
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const candidate = resolve(root, `.${requestedPath}`);
  const candidateRelativePath = relative(root, candidate);
  if (isAbsolute(candidateRelativePath) || candidateRelativePath.startsWith("..")) {
    return null;
  }

  if (existsSync(candidate)) {
    return resolveExistingAsset(root, candidate);
  }

  if (pathname !== "/" && !extname(pathname) && !pathname.startsWith("/assets/")) {
    return resolveExistingAsset(root, resolve(root, "index.html"));
  }

  return null;
}

function resolveExistingAsset(root: string, candidate: string): string | null {
  if (!existsSync(candidate)) {
    return null;
  }

  const resolvedCandidate = realpathSync(candidate);
  const resolvedRelativePath = relative(root, resolvedCandidate);
  if (isAbsolute(resolvedRelativePath) || resolvedRelativePath.startsWith("..")) {
    return null;
  }

  return resolvedCandidate;
}
