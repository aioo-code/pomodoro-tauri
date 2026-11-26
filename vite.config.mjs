import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
const resolve = value => fileURLToPath(new URL(value, import.meta.url));
export default defineConfig({
  root: resolve('./frontend'),
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': resolve('./frontend') } },
  build: { outDir: resolve('./dist'), emptyOutDir: true, rollupOptions: { input: { main: resolve('./frontend/index.html'), reminder: resolve('./frontend/reminder.html') } } },
});
