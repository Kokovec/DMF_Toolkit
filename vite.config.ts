import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // API server (npm run server) for the parts library and workloads.
  server: { proxy: { '/api': 'http://127.0.0.1:3001' } },
})
