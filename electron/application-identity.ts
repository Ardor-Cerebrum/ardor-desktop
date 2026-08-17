import { resolve } from "node:path";

export type DesktopApplicationName = "Ardor" | "Ardor Dev" | "Ardor Update Test";
export type DesktopChannel = "prod" | "stage1" | "update-test";

export interface DesktopApplicationIdentity {
  applicationName: DesktopApplicationName;
  channel: DesktopChannel;
}

export function resolveDesktopApplicationIdentity({
  channel,
  executablePath,
  isPackaged,
}: {
  channel?: string;
  executablePath: string;
  isPackaged: boolean;
}): DesktopApplicationIdentity {
  if (isPackaged) {
    const executableFilename = executablePath.split(/[\\/]/).at(-1) ?? "";
    const executableName = executableFilename.replace(/\.exe$/i, "");
    if (executableName === "Ardor") {
      return { applicationName: "Ardor", channel: "prod" };
    }
    if (executableName === "Ardor Update Test") {
      return { applicationName: "Ardor Update Test", channel: "update-test" };
    }
    return { applicationName: "Ardor Dev", channel: "stage1" };
  }

  if (channel === "prod") return { applicationName: "Ardor", channel };
  if (channel === "update-test") return { applicationName: "Ardor Update Test", channel };
  return { applicationName: "Ardor Dev", channel: "stage1" };
}

export function resolveDesktopUserDataPath(
  appDataPath: string,
  applicationName: DesktopApplicationName,
): string {
  return resolve(appDataPath, applicationName);
}
