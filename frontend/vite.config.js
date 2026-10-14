import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { readFileSync } from 'node:fs';
import { demoAssetsPlugin } from './tooling/demoAssetsPlugin.mjs';

const target = process.env.HMI_BACKEND_URL ?? 'http://127.0.0.1:3001';
if (!['http://127.0.0.1:3001', 'http://127.0.0.1:3002'].includes(target)) {
  throw new Error('HMI_BACKEND_URL phải là backend loopback đã duyệt');
}

const enableHttps = process.env.HTTPS === 'true';
const certPath = process.env.HMI_TLS_CERT_PATH;
const keyPath = process.env.HMI_TLS_KEY_PATH;
if (Boolean(certPath) !== Boolean(keyPath)) {
  throw new Error('HMI_TLS_CERT_PATH và HMI_TLS_KEY_PATH phải đi cùng nhau');
}
// A LAN browser needs a certificate whose SAN contains the server's LAN IP.
// The local-only basicSsl option remains available for the existing dev flow.
const https = certPath ? {
  cert: readFileSync(certPath),
  key: readFileSync(keyPath),
} : undefined;
const proxy = () => {
  // The backend stays on loopback. Forward the browser's HTTPS scheme so
  // express-session can issue Secure cookies in the opt-in LAN mode.
  const base = { target, changeOrigin: false, xfwd: true };
  return {
    '/api': { ...base },
    '/ws': { ...base, ws: true },
    '/map-stream': { ...base, ws: true },
  };
};

export default defineConfig({
  plugins: [
    react(),
    demoAssetsPlugin(),
    enableHttps && !https && basicSsl(),
  ].filter(Boolean),
  server: {
    https,
    proxy: proxy(),
  },
  // Serve built assets to other LAN devices without exposing the source/HMR
  // endpoints of the development server. API and WS stay on the same origin.
  preview: {
    https,
    proxy: proxy(),
  },
});
