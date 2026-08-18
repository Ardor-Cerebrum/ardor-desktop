export interface MacOSUserDefaults {
  setUserDefault(key: string, type: "boolean", value: boolean): void;
}

export function configureMacOSAutofillPolicy(
  preferences: MacOSUserDefaults,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "darwin") return;
  preferences.setUserDefault("NSAutoFillHeuristicsEnabled", "boolean", false);
}
