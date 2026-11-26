import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const env = { ...process.env, CARGO_HOME: path.join(root, '.cargo-home'), CARGO_TARGET_DIR: path.join(root, 'src-tauri/target'), TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp') };
mkdirSync(env.TEMP, { recursive: true });
