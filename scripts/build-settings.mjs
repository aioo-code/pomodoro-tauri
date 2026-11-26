import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { root, env } from './environment.mjs';

const builds = path.join(root, 'artifacts/builds');
mkdirSync(builds, {recursive: true});
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const output = mkdtempSync(path.join(builds, version + '-'));
function run(file, args, extra = {}) {
  const result = spawnSync(file, args, { cwd: root, env, windowsHide: true, encoding: 'utf8', ...extra });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const files = [];
function collect(directory) {
  for (const file of readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${file.name}`;
    if (file.isDirectory()) collect(relative);
    else if (/\.(tsx?|css|rs|woff2|json|txt|html|svg|png|ico|icns|rgba)$/.test(file.name)) files.push(relative);
  }
}
collect('frontend'); collect('src-tauri/src');
collect('src-tauri/icons');
collect('src-tauri/capabilities');
files.push('app-icon.svg','packaging/windows/start.ps1','packaging/windows/install-hooks.nsh');
files.push('packaging/windows/refresh-shortcut-icons.ps1');
files.push('package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'src-tauri/build.rs');
const hashes = () => Object.fromEntries(files.sort().map(file => [file, createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex')]));
const sources = hashes();
writeFileSync(path.join(root, 'tmp/settings-build-current.json'), JSON.stringify({ version, output }, null, 2));
console.log(`Building ${version}`);
const child = spawn(process.execPath, [path.join(root, 'scripts/tauri.mjs'), 'build', '--no-bundle', '--config', JSON.stringify({ version })], { cwd: root, env: { ...env, POMODORO_BUILD_VERSION: version }, windowsHide: true, stdio: 'inherit' });
const [code] = await once(child, 'exit');
if (code !== 0) throw new Error(`Build failed with code ${code}.`);
if (JSON.stringify(hashes()) !== JSON.stringify(sources)) throw new Error('Build inputs changed during compilation; do not publish this candidate.');
const exe = path.join(output, 'pomodoro-connected.exe');
cpSync(path.join(root, 'src-tauri/target/release/pomodoro-connected.exe'), exe);
const productVersion = run('pwsh', ['-NoProfile', '-Command', '(Get-Item -LiteralPath $env:POMODORO_INSPECT_EXE).VersionInfo.ProductVersion'], { env: { ...env, POMODORO_INSPECT_EXE: exe } });
if (productVersion !== version) throw new Error(`Native version ${productVersion} does not match ${version}`);
mkdirSync(path.join(output, 'scripts'), { recursive: true });
writeFileSync(path.join(output, 'scripts/tool-call.ps1'), readFileSync(path.join(root, 'scripts/tool-call.ps1'), 'utf8').replace('../src-tauri/target/release/pomodoro-connected.exe', '../pomodoro-connected.exe'));
cpSync(path.join(root, 'frontend/public/fonts'), path.join(output, 'licenses/fonts'), { recursive: true });
cpSync(path.join(root, 'frontend/components/reactbits/LICENSE.md'), path.join(output, 'licenses/react-bits.md'));
cpSync(path.join(root, 'licenses/audio-original.md'), path.join(output, 'licenses/audio-original.md'));
cpSync(path.join(root, 'licenses/windows-material-reference.md'), path.join(output, 'licenses/windows-material-reference.md'));
cpSync(path.join(root, 'frontend/components/reactbits/ScrollChroma.LICENSE.md'), path.join(output, 'licenses/react-bits-scroll-chroma.md'));
cpSync(path.join(root, 'frontend/components/reactbits/scroll-chroma-sources.json'), path.join(output, 'licenses/react-bits-scroll-chroma-sources.json'));
cpSync(path.join(root, 'frontend/components/reactbits/ElasticSlider.LICENSE.md'), path.join(output, 'licenses/react-bits-elastic-slider.md'));
cpSync(path.join(root, 'frontend/components/reactbits/micro-sources.json'), path.join(output, 'licenses/react-bits-sources.json'));
cpSync(path.join(root, 'frontend/components/reactbits/TimerEffects.LICENSE.md'), path.join(output, 'licenses/react-bits-timer-effects.md'));
cpSync(path.join(root, 'frontend/components/reactbits/timer-effect-sources.json'), path.join(output, 'licenses/react-bits-timer-effect-sources.json'));
cpSync(path.join(root, 'LICENSE'), path.join(output, 'licenses/LICENSE'));
cpSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), path.join(output, 'licenses/THIRD_PARTY_NOTICES.md'));
writeFileSync(path.join(output,'start.ps1'),readFileSync(path.join(root,'packaging/windows/start.ps1'),'utf8'));
writeFileSync(path.join(output,'scripts/refresh-shortcut-icons.ps1'),'\ufeff'+readFileSync(path.join(root,'packaging/windows/refresh-shortcut-icons.ps1'),'utf8').replace(/^\uFEFF/,''));
const sha256 = createHash('sha256').update(readFileSync(exe)).digest('hex');
writeFileSync(path.join(output, 'package.json'), JSON.stringify({ name: 'pomodoro', version, executable: 'pomodoro-connected.exe', launcher: 'start.ps1' }, null, 2));
writeFileSync(path.join(output, 'delivery.json'), JSON.stringify({ version, productVersion, sha256, sources, builtAt: new Date().toISOString(), acceptance: 'pending', scope: 'Local build; desktop acceptance pending.' }, null, 2));
console.log(JSON.stringify({ version, output, sha256 }));
