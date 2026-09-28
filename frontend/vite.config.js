import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { demoAssetsPlugin } from './tooling/demoAssetsPlugin.mjs'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), demoAssetsPlugin()],
})
