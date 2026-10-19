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
    case "update-test":
      return {
        bundleId: "cloud.ardor.desktop.update-test",
        name: "ardor-desktop-update-test",
        productName: "Ardor Update Test",
      };
    default:
      throw new Error(`Unsupported Electron channel: ${channel}`);
  }
}

export function resolveElectronPackageMetadata(packageJson, { channel, version }) {
  const { name, productName } = resolveElectronPackageIdentity(channel);
  return { ...packageJson, name, productName, ...(version ? { version } : {}) };
}

export async function stampElectronPackageIdentity(buildPath, channel, { version } = {}) {
  const packagePath = resolve(buildPath, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const metadata = resolveElectronPackageMetadata(packageJson, { channel, version });
  await writeFile(packagePath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}
