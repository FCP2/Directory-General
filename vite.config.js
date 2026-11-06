import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  publicDir: false,
  build: {
    outDir: 'public/react-dist',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/client/main.jsx',
      output: {
        entryFileNames: 'app.js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'app.[ext]'
      }
    }
  }
});
