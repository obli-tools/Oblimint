import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { readFileSync } from 'fs';

const { version: clientVersion } = JSON.parse(
  readFileSync(path.resolve(__dirname, './package.json'), 'utf-8'),
) as { version: string };

const API_TARGET = 'http://localhost:3025';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(clientVersion),
  },
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@oblimint/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
  build: {
    // Same syntax baseline as Obliance (Vite "modules" baseline, no polyfills).
    target: ['es2020', 'chrome87', 'edge88', 'firefox78', 'safari14'],
    rollupOptions: {
      // Panel + the Oblimint webmail (webmail.html, served by the panel's webmail
      // listener on the webmail host only — never on the panel host).
      input: {
        main: path.resolve(__dirname, 'index.html'),
        webmail: path.resolve(__dirname, 'webmail.html'),
      },
    },
  },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        ws: true,
      },
      '/auth': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/health': {
        target: API_TARGET,
        changeOrigin: true,
      },
      '/socket.io': {
        target: API_TARGET,
        ws: true,
      },
      // Oblimint webmail (open http://localhost:5174/webmail.html): its own
      // listener (OBLIMINT_WEBMAIL_PORT). Host kept: the listener checks Origin = Host.
      '/wm-api': {
        target: 'http://localhost:8082',
        changeOrigin: false,
      },
    },
  },
});
