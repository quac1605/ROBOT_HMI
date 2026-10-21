import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { readFileSync } from 'node:fs';
import { Agent } from 'node:https';
import { demoAssetsPlugin } from './tooling/demoAssetsPlugin.mjs';

const target = process.env.HMI_BACKEND_URL ?? 'http://127.0.0.1:3001';
if (!['http://127.0.0.1:3001', 'http://127.0.0.1:3002'].includes(target)) {
  throw new Error('HMI_BACKEND_URL phải là backend loopback đã duyệt');
}

const enableHttps = process.env.HTTPS === 'true';
const certPath = process.env.HMI_TLS_CERT_PATH;
const keyPath = process.env.HMI_TLS_KEY_PATH;
const lanIp = process.env.HMI_LAN_IP;
const whepTarget = process.env.HMI_WHEP_PROXY_TARGET;
if (Boolean(certPath) !== Boolean(keyPath)) {
  throw new Error('HMI_TLS_CERT_PATH và HMI_TLS_KEY_PATH phải đi cùng nhau');
}
if (whepTarget && (!certPath || !lanIp ||
  whepTarget !== `https://${lanIp}:8889`)) {
  throw new Error('HMI_WHEP_PROXY_TARGET phải trỏ đến MediaMTX HTTPS cùng IP LAN và có chứng chỉ');
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
  const routes = {
    '/api': { ...base },
    '/ws': { ...base, ws: true },
    '/map-stream': { ...base, ws: true },
  };
  if (whepTarget) {
    const mediaOrigin = new URL(whepTarget).origin;
    routes['^/(front|rear)/whep(?:/|$)'] = {
      target: whepTarget,
      changeOrigin: true,
      // Trust only the LAN certificate already used for this HMI, not every
      // self-signed certificate on the network.
      agent: new Agent({ ca: readFileSync(certPath) }),
      secure: true,
      configure(proxyServer) {
        proxyServer.on('proxyRes', proxyResponse => {
          const location = proxyResponse.headers.location;
          if (!location) return;
          let resolved;
          try { resolved = new URL(location, whepTarget); }
          catch {
            delete proxyResponse.headers.location;
            return;
          }
          if (resolved.origin !== mediaOrigin ||
              !/^\/(front|rear)\/whep(?:\/|$)/.test(resolved.pathname)) {
            delete proxyResponse.headers.location;
            return;
          }
          // MediaMTX may return an absolute URL on :8889. Keep session
          // DELETE on the HMI origin, where this proxy handles it too.
          proxyResponse.headers.location =
            `https://${lanIp}:5173${resolved.pathname}${resolved.search}`;
        });
      },
    };
  }
  return routes;
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
