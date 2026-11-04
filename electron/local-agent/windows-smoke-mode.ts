/** The older Windows Server builder exercises rejection, never MXC enforcement. */
export function localAgentSmokeMode(options: {
  platform: NodeJS.Platform;
  release: string;
  requested: string | undefined;
}): "supported" | "unavailable-windows" {
  if (options.requested === undefined) return "supported";
  if (options.requested !== "unavailable-windows") throw new Error("Unknown local-agent smoke mode.");
  const version = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(options.release);
  if (options.platform !== "win32" || !version || Number(version[1]) !== 10 || Number(version[3]) >= 26100) {
    throw new Error("Unavailable Windows smoke requires an older Windows build; supported hosts must execute MXC.");
  }
  return "unavailable-windows";
}
