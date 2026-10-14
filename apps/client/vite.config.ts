import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { serveRenders } from './dev/serve-renders.js';

const hubProxy = {
  '/api': { target: 'http://127.0.0.1:8787' },
  '/ws': { target: 'http://127.0.0.1:8787', ws: true },
};

export default defineConfig({
  plugins: [preact(), serveRenders(fileURLToPath(new URL('./.dev-renders', import.meta.url)))],
  build: {
    target: 'es2022',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        harness: fileURLToPath(new URL('./harness.html', import.meta.url)),
      },
    },
  },
  server: { proxy: hubProxy },
  preview: { proxy: hubProxy },
});
