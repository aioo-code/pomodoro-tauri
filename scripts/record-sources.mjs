import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './environment.mjs';
const files = [
  ...['button', 'tabs', 'tooltip', 'dropdown-menu'].map(name => ({ path: `frontend/components/ui/${name}.tsx`, source: `https://ui.shadcn.com/r/styles/new-york-v4/${name}.json` })),
  { path: 'frontend/components/reactbits/ClickSpark.tsx', source: 'https://raw.githubusercontent.com/DavidHDev/react-bits/main/src/ts-default/Animations/ClickSpark/ClickSpark.tsx' },
  { path: 'frontend/components/reactbits/StarBorder.tsx', source: 'https://raw.githubusercontent.com/DavidHDev/react-bits/main/src/ts-default/Animations/StarBorder/StarBorder.tsx' },
  { path: 'frontend/components/reactbits/StarBorder.css', source: 'https://raw.githubusercontent.com/DavidHDev/react-bits/main/src/ts-default/Animations/StarBorder/StarBorder.css' },
  { path: 'app-icon.svg', source: 'Original project SVG, inspired by Fluent material and gradient principles; no Microsoft logo assets copied.' },
  { path: 'src-tauri/src/material.rs', source: 'https://learn.microsoft.com/en-us/windows/win32/api/dwmapi/ne-dwmapi-dwm_systembackdrop_type' },
  ...['frontend/App.tsx', 'frontend/style.css', 'frontend/components/titlebar.tsx', 'frontend/hooks/use-clock.ts', 'frontend/lib/drag.ts', 'src-tauri/src/drag.rs'].map(path => ({ path, source: 'Project-specific UI implementation.' })),
  ...['src-tauri/src/main.rs', 'src-tauri/src/timer.rs', 'src-tauri/src/tool.rs', 'src-tauri/src/tool_ipc.rs', 'src-tauri/src/request_log.rs', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json'].map(path => ({ path, source: 'Project-specific connected timer implementation and resolved build inputs.' })),
];
const version = process.argv.find(arg => arg.startsWith('--version='))?.slice('--version='.length) ?? JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid artifact version.');
const manifest = {
  recordedAt: new Date().toISOString(),
  artifactVersion: version,
  packages: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')),
  adaptation: 'shadcn official registry sources: cn import mapped to local clsx/tailwind-merge utility; app composition and theme are project-specific. React Bits provenance is recorded in the component directory.',
  files: files.map(file => ({ ...file, sha256: createHash('sha256').update(readFileSync(path.join(root, file.path))).digest('hex') })),
};
const destination = path.join(root, `artifacts/v${version}/sources`);
mkdirSync(destination, { recursive: true });
writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Recorded source versions and SHA256.');
