import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // Native module — must be required at runtime, not bundled.
      external: ['better-sqlite3'],
    },
  },
});
