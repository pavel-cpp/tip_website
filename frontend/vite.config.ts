import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // ws: true forwards the realtime WebSocket endpoint as well.
      '/api': { target: 'http://localhost:8080', ws: true, changeOrigin: false },
    },
  },
  build: {
    target: ['es2022', 'safari16'],
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
})
