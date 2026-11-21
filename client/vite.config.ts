import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Overridable so a second stack (a stub-provider server, say) can be run
// alongside the usual one for tests.
const SERVER = process.env.SERVER_URL ?? 'http://localhost:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/sync': { target: SERVER, ws: true, changeOrigin: true },
      '/events': { target: SERVER, ws: true, changeOrigin: true },
      '/terminal': { target: SERVER, ws: true, changeOrigin: true },
      '/chat': { target: SERVER, ws: true, changeOrigin: true },
    },
  },
});
