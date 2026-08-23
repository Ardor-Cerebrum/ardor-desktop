export const TERMINAL_SHELL_PROFILE_IDS = [
  "wsl-default",
  "pwsh",
  "windows-powershell",
  "git-bash",
  "cmd",
  "system",
] as const;

export type TerminalShellProfileId = typeof TERMINAL_SHELL_PROFILE_IDS[number];

export interface TerminalShellProfile {
  readonly id: TerminalShellProfileId;
  readonly label: string;
}

export interface TerminalShellProfileCatalog {
  readonly defaultProfileId: TerminalShellProfileId | null;
  readonly profiles: readonly TerminalShellProfile[];
}

export function isTerminalShellProfileId(value: unknown): value is TerminalShellProfileId {
  return typeof value === "string" && TERMINAL_SHELL_PROFILE_IDS.includes(value as TerminalShellProfileId);
}
