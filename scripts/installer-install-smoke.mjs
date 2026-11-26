import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { root, env } from './environment.mjs';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const receipt = read(path.join(root, 'tmp/installer-current.json'));
assert.equal(hash(receipt.installer), receipt.sha256);
const id = randomUUID();
const product = 'PomodoroAcceptance-' + id;
const bundle = 'local.pomodoro.acceptance.' + id;
const run = path.join(receipt.stage, 'install-smoke', id);
const installed = path.join(run, 'installed');
const setup = path.join(run, 'setup.exe');
const uninstaller = path.join(installed, 'uninstall.exe');
const app = path.join(installed, 'pomodoro-connected.exe');
const evidence = path.join(run, 'desktop');
mkdirSync(run, { recursive: true });
assert.ok(!/\s/.test(installed), 'NSIS /D and _?= paths require an unquoted fixture path');

const compilerRoot = path.join(receipt.target, '.tauri/NSIS');
const compiler = path.join(compilerRoot, 'Bin/makensis.exe');
const source = path.join(receipt.target, 'release/nsis/x64/installer.nsi');
const releaseScript = readFileSync(source, 'utf8');
assert.match(releaseScript, /RequestExecutionLevel user/);
assert.match(releaseScript, /^!define INSTALLMODE "currentUser"/m);
assert.doesNotMatch(releaseScript, /WriteRegStr SHCTX "Software\\Classes/);
const releaseHooks = path.join(receipt.stage, 'update-hooks.nsh');
const fixtureHooks = path.join(run, 'hooks.nsh');
writeFileSync(fixtureHooks, '!define POMODORO_UPDATE_ARGS "--tool-qa"\n' + readFileSync(releaseHooks, 'utf8'));

function setDefine(script, name, value) {
  const line = new RegExp('^!define ' + name + ' "[^"\\r\\n]*"\\r?$', 'gm');
  assert.equal([...script.matchAll(line)].length, 1, 'Missing or ambiguous NSIS define: ' + name);
  return script.replace(line, () => '!define ' + name + ' "' + value + '"');
}

let fixtureScript = setDefine(releaseScript, 'PRODUCTNAME', product);
fixtureScript = setDefine(fixtureScript, 'BUNDLEID', bundle);
fixtureScript = setDefine(fixtureScript, 'OUTFILE', setup);
const include = /^!include "([^"\r\n]*[\\/]update-hooks\.nsh)"\r?$/gm;
assert.equal([...fixtureScript.matchAll(include)].length, 1, 'Missing or ambiguous installer hooks');
fixtureScript = fixtureScript.replace(include, () => '!include "' + fixtureHooks + '"');
const generated = path.join(run, 'installer.nsi');
writeFileSync(generated, '\ufeff' + fixtureScript.replace(/^\ufeff/, ''));

function runCommand(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: path.dirname(source), env: { ...env, NSISDIR: compilerRoot },
    encoding: 'utf8', windowsHide: true, timeout: 180_000, ...options,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, file + '\n' + result.stdout + '\n' + result.stderr);
  return result.stdout;
}

runCommand(compiler, ['/V2', '/NOCD', generated]);
const uninstallKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\' + product;
try {
  runCommand(setup, ['/S', '/NS', '/D=' + installed]);
  assert.equal(hash(app), receipt.programSha256, 'Installed application differs from the release payload');
  assert.equal(hash(path.join(installed, 'licenses', 'LICENSE')), hash(path.join(root, 'LICENSE')));
  assert.ok(runCommand('reg.exe', ['query', uninstallKey, '/v', 'DisplayVersion']).includes(receipt.version));
  runCommand(process.execPath, [path.join(root, 'scripts/acceptance.mjs'), '--no-native-capture'], {
    env: { ...env, POMODORO_EXE: app, POMODORO_EVIDENCE: evidence },
  });
  assert.equal(read(path.join(evidence, 'desktop-acceptance.json')).result, 'passed');
} finally {
  if (existsSync(uninstaller)) runCommand(uninstaller, ['/S', '_?=' + installed]);
}

assert.ok(!existsSync(app), 'Uninstaller left the application in the fixture');
const registration = spawnSync('reg.exe', ['query', uninstallKey], { windowsHide: true });
assert.equal(registration.status, 1, 'The fixture uninstall registration was not removed');
const result = {
  passed: true, version: receipt.version, sha256: receipt.sha256,
  programSha256: receipt.programSha256, evidence,
  scope: 'Generated NSIS script in an isolated product registration, with the exact release payload',
};
writeFileSync(path.join(path.dirname(receipt.installer), 'install-smoke.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
