import { resolve } from "node:path";

export type DesktopApplicationName = "Ardor" | "Ardor Dev";
export type DesktopChannel = "prod" | "stage1";

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
  if (channel === "prod") return { applicationName: "Ardor", channel };
  if (channel === "stage1") return { applicationName: "Ardor Dev", channel };

  if (isPackaged) {
    const executableFilename = executablePath.split(/[\\/]/).at(-1) ?? "";
    const executableName = executableFilename.replace(/\.exe$/i, "");
    if (executableName === "Ardor") {
      return { applicationName: "Ardor", channel: "prod" };
    }
  }

  return { applicationName: "Ardor Dev", channel: "stage1" };
}

export function resolveDesktopUserDataPath(
  appDataPath: string,
  applicationName: DesktopApplicationName,
): string {
  return resolve(appDataPath, applicationName);
}
