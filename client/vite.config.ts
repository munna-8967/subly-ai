import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Development: `npm run dev` (API on :3000) + `npm run dev:client` (this, on :5173).
// Production: `npm run build` writes client/dist, which the Node server serves itself.
export default defineConfig({
  root: here,
  plugins: [react()],
  build: { outDir: path.join(here, 'dist'), emptyOutDir: true, sourcemap: false },
  server: {
    port: 5173,
    fs: { allow: [path.resolve(here, '..')] },
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
