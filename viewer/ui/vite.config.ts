import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev, proxy API + SSE to the backend (local or the live Railway URL via VITE_API_TARGET).
const target = process.env.VITE_API_TARGET || 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target, changeOrigin: true },
      '/health': { target, changeOrigin: true },
    },
  },
});
