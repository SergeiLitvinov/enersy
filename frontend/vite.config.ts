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
    },
    proxy: {
      '/api': {
        target: 'http://go-api:8080',
        changeOrigin: true
      }
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
});