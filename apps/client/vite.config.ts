import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { serveRenders } from './dev/serve-renders.js';

export default defineConfig({
  plugins: [preact(), serveRenders(fileURLToPath(new URL('./.dev-renders', import.meta.url)))],
  build: { target: 'es2022' },
});
