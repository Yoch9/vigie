import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// En développement, l'API est servie par `npm run dev:server` (port 3001).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { '/api': { target: 'http://localhost:3001', changeOrigin: false } },
  },
});
