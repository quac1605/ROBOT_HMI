import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl'; // Thêm dòng này
import { demoAssetsPlugin } from './tooling/demoAssetsPlugin.mjs';

const target = process.env.HMI_BACKEND_URL ?? 'http://127.0.0.1:3001';
if (!['http://127.0.0.1:3001', 'http://127.0.0.1:3002'].includes(target)) {
  throw new Error('HMI_BACKEND_URL phải là backend loopback đã duyệt');
}

const base = { target, changeOrigin: false };
const enableHttps = process.env.HTTPS === 'true';

export default defineConfig({
  plugins: [
    react(),
    demoAssetsPlugin(),
    enableHttps && basicSsl(), // Thêm dòng này
  ].filter(Boolean),
  server: {
    proxy: {
      '/api': { ...base },
      '/ws': { ...base, ws: true },
      '/map-stream': { ...base, ws: true },
    },
  },
});
