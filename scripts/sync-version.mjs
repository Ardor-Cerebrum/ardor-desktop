import { readFileSync, writeFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const { version } = packageJson;

if (!version) {
  throw new Error("package.json does not define a version");
}

const writeJson = (path, value) => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

const tauriConfigPath = "src-tauri/tauri.conf.json";
const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, "utf8"));
tauriConfig.version = version;
writeJson(tauriConfigPath, tauriConfig);

const cargoTomlPath = "src-tauri/Cargo.toml";
const cargoToml = readFileSync(cargoTomlPath, "utf8");
const cargoTomlVersionPattern = /(\[package\][\s\S]*?\nversion = ")[^"]+(")/;

if (!cargoTomlVersionPattern.test(cargoToml)) {
  throw new Error("Could not update package.version in src-tauri/Cargo.toml");
}

const nextCargoToml = cargoToml.replace(cargoTomlVersionPattern, `$1${version}$2`);
writeFileSync(cargoTomlPath, nextCargoToml);

const cargoLockPath = "src-tauri/Cargo.lock";
const cargoLock = readFileSync(cargoLockPath, "utf8");
const cargoLockVersionPattern =
  /(\[\[package\]\]\nname = "ardor-solutions-desktop"\nversion = ")[^"]+(")/;

if (!cargoLockVersionPattern.test(cargoLock)) {
  throw new Error("Could not update ardor-solutions-desktop in src-tauri/Cargo.lock");
}

const nextCargoLock = cargoLock.replace(cargoLockVersionPattern, `$1${version}$2`);
writeFileSync(cargoLockPath, nextCargoLock);
