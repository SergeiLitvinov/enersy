import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['enersy.onrender.com', 'localhost', '127.0.0.1'],
    port: 3000,
    host: '0.0.0.0',
    hmr: {
      clientPort: 3000
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
});