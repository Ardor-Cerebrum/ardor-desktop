import { resolve } from "node:path";

export type DesktopApplicationName = "Ardor" | "Ardor Dev";

export function resolveDesktopApplicationName({
  channel,
  executablePath,
  isPackaged,
}: {
  channel?: string;
  executablePath: string;
  isPackaged: boolean;
}): DesktopApplicationName {
  if (channel === "prod") return "Ardor";
  if (channel === "stage1") return "Ardor Dev";

  if (isPackaged) {
    const executableFilename = executablePath.split(/[\\/]/).at(-1) ?? "";
    const executableName = executableFilename.replace(/\.exe$/i, "");
    if (executableName === "Ardor") return "Ardor";
  }

  return "Ardor Dev";
}

export function resolveDesktopUserDataPath(
  appDataPath: string,
  applicationName: DesktopApplicationName,
): string {
  return resolve(appDataPath, applicationName);
}
