import { spawn } from 'node:child_process';
import { root, env } from './environment.mjs';
import path from 'node:path';
const child = spawn(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
