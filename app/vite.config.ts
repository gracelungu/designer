import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, Vite serves the UI and forwards API and WebSocket calls to the local server.
export default defineConfig({
  root: 'src/web',
  base: './',
  plugins: [react()],
  define: { __DEV_TOKEN__: JSON.stringify(process.env.NODE_ENV === 'production' ? '' : 'dev') },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:4818',
      '/ws': { target: 'ws://127.0.0.1:4818', ws: true },
    },
  },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
