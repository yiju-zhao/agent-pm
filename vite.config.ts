import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The page is built from `web/` into `dist/web`, which the server hosts at `/` (see src/server/web.ts).
// `npm run dev:web` serves it on Vite's own port and forwards the API and the live stream to a server on 8787.
const SERVER = 'http://127.0.0.1:8787';
const API_PATHS = ['/projects', '/questions', '/sessions', '/events', '/evidence', '/status', '/sync', '/admin'];

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    // The page imports shared files from ../src/shared.
    fs: { allow: ['..'] },
    proxy: {
      ...Object.fromEntries(API_PATHS.map((path) => [path, SERVER])),
      // changeOrigin stays false on purpose: the server rejects a WebSocket whose Origin host differs from its Host
      // header, and the browser's Origin is the dev server's, so Host must be forwarded unchanged too.
      '/stream': { target: 'ws://127.0.0.1:8787', ws: true },
    },
  },
});
