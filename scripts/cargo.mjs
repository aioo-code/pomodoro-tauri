import { spawn } from 'node:child_process';
import { root, env } from './environment.mjs';
import path from 'node:path';
const child = spawn('cargo', process.argv.slice(2), { cwd: path.join(root, 'src-tauri'), env, stdio: 'inherit' });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
