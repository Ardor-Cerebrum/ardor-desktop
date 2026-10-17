import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveLocalProjectPath } from "./protocol.js";

export function resolveExistingProjectFolder(value: unknown, platform: NodeJS.Platform): string {
  const path = realpathSync(resolveLocalProjectPath(value, platform));
  if (!statSync(path).isDirectory()) throw new Error("Choose an existing local project folder.");
  return path;
}

export function parseProjectName(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 120 || /\p{Cc}/u.test(value)) {
    throw new Error("Project name must contain 1 to 120 characters without control characters.");
  }
  return value.trim();
}

/** Only main-process configuration supplies the parent; the name is never a path. */
export function createManagedProjectFolder({ basePath, scopeParts, name, reservedRoots, platform }: {
  readonly basePath: string;
  readonly scopeParts: readonly string[];
  readonly name: string;
  readonly reservedRoots: ReadonlySet<string>;
  readonly platform: NodeJS.Platform;
}): string {
  mkdirSync(basePath, { recursive: true, mode: 0o700 });
  if (lstatSync(basePath).isSymbolicLink()) throw new Error("The managed projects directory must not be a link.");
  let parent = realpathSync(basePath);
  for (const part of scopeParts) {
    parent = join(parent, part);
    try {
      mkdirSync(parent, { mode: 0o700 });
    } catch (error) {
      if (!isExistingPath(error)) throw error;
    }
    const stat = lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("The managed projects directory must not contain links or files.");
    }
  }
  const folderName = portableFolderName(name);
  // Conservatively reserve aliases on macOS too, including its default case-insensitive volumes.
  const pathKey = (path: string) => platform === "darwin"
    ? path.normalize("NFC").toLowerCase()
    : platform === "win32" ? path.toLowerCase() : path;
  const reserved = new Set([...reservedRoots].map(pathKey));
  for (let attempt = 1; attempt <= 1000; attempt++) {
    const path = join(parent, attempt === 1 ? folderName : `${folderName} ${attempt}`);
    // Missing registered roots still own their chat history and must never be recycled.
    if (reserved.has(pathKey(path))) continue;
    try {
      // Exclusive mkdir avoids reusing an existing folder, file, junction or symlink.
      mkdirSync(path, { mode: 0o700 });
      return path;
    } catch (error) {
      if (!isExistingPath(error)) throw error;
    }
  }
  throw new Error("Too many projects with this folder name. Choose another project name.");
}

function portableFolderName(name: string): string {
  let bounded = "";
  for (const character of name) {
    if (Buffer.byteLength(bounded + character, "utf8") > 180) break;
    bounded += character;
  }
  const safe = bounded.replace(/[<>:"/\\|?*]/g, "_").replace(/[. ]+$/g, "") || "Project";
  return /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(safe) ? `_${safe}` : safe;
}

function isExistingPath(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}
