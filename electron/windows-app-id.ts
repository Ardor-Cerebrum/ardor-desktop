export function resolveWindowsAppUserModelId(channel: string | undefined): string {
  return channel === "prod"
    ? "com.squirrel.ardor.Ardor"
    : "com.squirrel.ardor-dev.Ardor Dev";
}
