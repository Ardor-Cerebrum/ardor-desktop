import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export function resolveElectronPackageIdentity(channel) {
  switch (channel) {
    case "prod":
      return {
        bundleId: "cloud.ardor.desktop",
        name: "ardor-desktop",
        productName: "Ardor",
      };
    case "stage1":
      return {
        bundleId: "cloud.ardor.desktop.stage1",
        name: "ardor-desktop-stage1",
        productName: "Ardor Dev",
      };
    default:
      throw new Error(`Unsupported Electron channel: ${channel}`);
  }
}

export async function stampElectronPackageIdentity(buildPath, channel) {
  const packagePath = resolve(buildPath, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const { name, productName } = resolveElectronPackageIdentity(channel);
  await writeFile(packagePath, `${JSON.stringify({ ...packageJson, name, productName }, null, 2)}\n`, "utf8");
}
