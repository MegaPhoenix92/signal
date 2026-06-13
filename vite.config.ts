import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const containsPath = (id: string, path: string) => id.indexOf(path) !== -1;
const hasPathSuffix = (id: string, suffix: string) => id.slice(-suffix.length) === suffix;

export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (containsPath(id, '/node_modules/react') || containsPath(id, '/node_modules/react-dom')) {
            return 'react-vendor';
          }
          if (containsPath(id, '/node_modules/lucide-react')) {
            return 'icons';
          }
          if (hasPathSuffix(id, '/src/signalData.ts')) {
            return 'signal-data';
          }
          return undefined;
        },
      },
    },
  },
  plugins: [react()],
});
