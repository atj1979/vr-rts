import { defineConfig } from 'vite';

// GitHub Pages project site: https://atj1979.github.io/vr-rts/
export default defineConfig({
  base: '/vr-rts/',
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
  server: {
    host: true,
    port: 5173,
  },
});
