import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(projectRoot, 'client'),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    fs: { allow: [projectRoot] },
    proxy: { '/api': 'http://127.0.0.1:3001', '/socket.io': { target: 'http://127.0.0.1:3001', ws: true } }
  },
  build: { outDir: resolve(projectRoot, 'dist'), emptyOutDir: true },
  optimizeDeps: { include: ['react', 'react-dom/client', 'socket.io-client'] }
});
