import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      // Native module — must be required at runtime, not bundled. kuromoji
      // reads its 17 MB dictionary from its own package folder, so it stays
      // a runtime require too (forge.config copies both into the package).
      external: ['better-sqlite3', 'kuromoji'],
    },
  },
});
