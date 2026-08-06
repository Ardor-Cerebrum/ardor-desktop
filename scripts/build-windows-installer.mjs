import { createHash } from 'node:crypto';
import { createReadStream, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveCefBuildPaths, withCefBuildEnv } from './cef-build-env.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoDir = resolve(scriptDir, '..');
const windowsTarget = 'x86_64-pc-windows-msvc';
const tauriCefRevision = '9851021fae837e6fa0316577f01f10f59143695b';

function fail(message) {
  console.error(message);
  process.exit(1);
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`);
  return value;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoDir,
    env: options.env ?? process.env,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.error) fail(`Failed to start ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = options.capture ? result.stderr.trim() : '';
    fail(detail || `${command} exited with code ${result.status}`);
  }
  return options.capture ? result.stdout.trim() : '';
}

function isWsl() {
  if (process.platform !== 'linux') return false;
  const result = spawnSync('uname', ['-r'], { encoding: 'utf8' });
  return result.status === 0 && /microsoft|wsl/i.test(result.stdout);
}

function defaultOutputDir() {
  if (process.platform === 'win32') {
    return join(process.env.USERPROFILE ?? repoDir, 'Downloads');
  }
  if (isWsl()) {
    const windowsProfile = run(
      'powershell.exe',
      ['-NoProfile', '-Command', "[Environment]::GetFolderPath('UserProfile')"],
      { cwd: '/mnt/c', capture: true },
    );
    return `${run('wslpath', ['-u', windowsProfile], { capture: true })}/Downloads`;
  }
  return resolve(repoDir, 'artifacts/windows');
}

function commandWorks(command, args) {
  return spawnSync(command, args, { cwd: repoDir, stdio: 'ignore' }).status === 0;
}

function hasMatchingCefTauriCli() {
  const result = spawnSync('cargo', ['install', '--list'], {
    cwd: repoDir,
    encoding: 'utf8',
  });
  return result.status === 0
    && result.stdout.includes('tauri-cli')
    && result.stdout.includes(tauriCefRevision.slice(0, 8));
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

const channel = readOption('--channel') ?? 'stage1';
if (!['stage1', 'prod'].includes(channel)) fail('--channel must be stage1 or prod');

const uiDir = resolve(
  readOption('--ui-dir') ?? process.env.ARDOR_SOLUTIONS_UI_DIR ?? resolve(repoDir, '../solutions-ui'),
);
if (!existsSync(resolve(uiDir, 'package.json'))) {
  fail(`solutions-ui checkout not found at ${uiDir}; pass --ui-dir <path>`);
}

const outputDir = resolve(readOption('--output-dir') ?? defaultOutputDir());
const planOnly = process.argv.includes('--plan');
const buildEnv = withCefBuildEnv({ ...process.env, ARDOR_SOLUTIONS_UI_DIR: uiDir });
const buildCommand = process.platform === 'win32'
  ? { command: 'bun', args: ['scripts/run-tauri.mjs', 'build', channel, '--bundles', 'nsis'] }
  : {
      command: 'bun',
      args: [
        'scripts/run-tauri.mjs',
        'build',
        channel,
        '--runner',
        'cargo-xwin',
        '--target',
        windowsTarget,
        '--bundles',
        'nsis',
      ],
    };

console.log(`Windows installer source: ${repoDir}`);
console.log(`Windows installer UI: ${uiDir}`);
console.log(`Windows installer command: ${buildCommand.command} ${buildCommand.args.join(' ')}`);
console.log(`Windows installer output: ${outputDir}`);

if (planOnly) {
  console.log('Plan only: no dependencies were installed and no build was started.');
  process.exit(0);
}

if (!existsSync(resolve(repoDir, 'node_modules'))) run('bun', ['install', '--frozen-lockfile']);
if (!existsSync(resolve(uiDir, 'node_modules'))) {
  run('bun', ['install', '--frozen-lockfile'], { cwd: uiDir });
}
if (!hasMatchingCefTauriCli()) run('bun', ['run', 'tauri:install-cef-cli']);
if (!commandWorks('cmake', ['--version'])) fail('cmake is required to build CEF.');
if (!commandWorks('ninja', ['--version'])) fail('ninja is required to build CEF.');
if (!commandWorks('clang-cl', ['--version'])) fail('clang-cl 19 or newer is required.');
const clangVersion = run('clang-cl', ['--version'], { capture: true }).match(/clang version (\d+)/i)?.[1];
if (!clangVersion || Number(clangVersion) < 19) {
  fail(`clang-cl 19 or newer is required; found ${clangVersion ?? 'an unknown version'}.`);
}
if (process.platform !== 'win32') {
  if (!commandWorks('cargo', ['xwin', '--version'])) fail('cargo-xwin is required.');
  if (!commandWorks('makensis', ['-VERSION'])) fail('makensis is required.');
}

run('bun', ['run', 'ui:type-check'], { env: buildEnv });
run(buildCommand.command, buildCommand.args, { env: buildEnv });

const targetDir = resolve(repoDir, resolveCefBuildPaths(buildEnv).targetDir);
const bundleDir = process.platform === 'win32'
  ? resolve(targetDir, 'release/bundle/nsis')
  : resolve(targetDir, `${windowsTarget}/release/bundle/nsis`);
const installer = readdirSync(bundleDir)
  .filter((name) => name.toLowerCase().endsWith('.exe'))
  .map((name) => ({ path: join(bundleDir, name), stat: statSync(join(bundleDir, name)) }))
  .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0];
if (!installer) fail(`No NSIS installer was produced in ${bundleDir}`);

const revision = run('git', ['rev-parse', '--short=7', 'HEAD'], { capture: true });
const dirty = run('git', ['status', '--porcelain'], { capture: true }) ? '-dirty' : '';
const product = channel === 'stage1' ? 'Ardor-Dev' : 'Ardor';
const outputPath = join(outputDir, `${product}-CEF-compositor-${revision}${dirty}-Windows-x64-setup.exe`);
mkdirSync(outputDir, { recursive: true });
copyFileSync(installer.path, outputPath);

console.log(`INSTALLER_PATH=${outputPath}`);
console.log(`INSTALLER_SIZE=${statSync(outputPath).size}`);
console.log(`INSTALLER_SHA256=${await sha256(outputPath)}`);
