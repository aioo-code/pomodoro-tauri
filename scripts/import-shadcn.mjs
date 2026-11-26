import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './environment.mjs';
const components = ['button', 'tabs', 'tooltip', 'dropdown-menu'];
const dependencies = new Set();
for (const component of components) {
  const item = JSON.parse(readFileSync(path.join(root, `artifacts/v0.3.0/sources/${component}.json`), 'utf8'));
  for (const file of item.files) {
    if (!file.path.endsWith(`/${component}.tsx`)) throw new Error(`Unexpected registry path: ${file.path}`);
    const target = path.join(root, `frontend/components/ui/${component}.tsx`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content.replaceAll('from "cn"', 'from "@/lib/utils"'));
  }
  for (const dependency of item.dependencies ?? []) if (dependency !== 'cn') dependencies.add(dependency);
}
console.log([...dependencies].join(' '));
