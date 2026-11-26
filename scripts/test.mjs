import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root, env } from './environment.mjs';

const tests = mkdtempSync(path.join(env.TEMP, 'rust-tests-'));
try {
  const compiler = path.join(root, 'node_modules/typescript/bin/tsc');
  const vite = path.join(root, 'node_modules/vite/bin/vite.js');
  const cargo = path.join(root, 'scripts/cargo.mjs');
  for (const args of [[compiler, '--noEmit'], [vite, 'build'], [cargo, 'test', '--locked']]) {
    const result = spawnSync(process.execPath, args, {
      cwd: root, env: { ...env, POMODORO_TOOL_TEST_ROOT: tests }, stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  rmSync(tests, { recursive: true });
}
