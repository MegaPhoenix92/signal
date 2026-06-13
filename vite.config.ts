import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/react') || id.includes('/node_modules/react-dom')) {
            return 'react-vendor';
          }
          if (id.includes('/node_modules/lucide-react')) {
            return 'icons';
          }
          if (id.endsWith('/src/signalData.ts')) {
            return 'signal-data';
          }
          return undefined;
        },
      },
    },
  },
  plugins: [react()],
});
