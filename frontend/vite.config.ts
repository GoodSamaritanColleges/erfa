import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: '/erfa/',
  build: {
    sourcemap: true,
    target: 'es2020',
    rollupOptions: {
      output: {
        // Keep rarely-changing libraries in their own long-cached chunk.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('lucide-react')) return 'icons';
          if (/[/\\](react|react-dom|react-router|react-router-dom|scheduler)[/\\]/.test(id)) return 'vendor';
          return undefined;
        }
      }
    }
  }
});
