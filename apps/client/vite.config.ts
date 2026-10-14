import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { serveRenders } from './dev/serve-renders.js';

const hubProxy = {
  '/api': { target: process.env.HUB_DEV_URL ?? 'http://127.0.0.1:8787' },
  '/ws': { target: process.env.HUB_DEV_URL ?? 'http://127.0.0.1:8787', ws: true },
};

/**
 * Gives public/sw.js a cache name that changes with the build. The emitted file names carry content hashes, so the
 * id changes exactly when the bundle does; the worker's activate step then drops the previous build's cache.
 * Runs in closeBundle because Vite copies public/ into dist only after the bundle is written.
 */
function stampServiceWorker(): Plugin {
  let id = '';
  let outDir = '';
  return {
    name: 'hub:stamp-service-worker',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    generateBundle(_options, bundle) {
      id = createHash('sha256').update(Object.keys(bundle).sort().join('\n')).digest('hex').slice(0, 12);
    },
    async closeBundle() {
      const file = join(outDir, 'sw.js');
      const source = await readFile(file, 'utf8');
      if (!source.includes('__BUILD_ID__')) throw new Error('sw.js has no __BUILD_ID__ placeholder to stamp');
      await writeFile(file, source.replaceAll('__BUILD_ID__', id));
    },
  };
}

export default defineConfig({
  plugins: [preact(), stampServiceWorker(), serveRenders(fileURLToPath(new URL('./.dev-renders', import.meta.url)))],
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
