// Bundles the local demo server: the real backend with src/store.ts swapped for dev/memoryStore.ts.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const memoryStore = fileURLToPath(new URL('./memoryStore.ts', import.meta.url));
await build({
  entryPoints: [fileURLToPath(new URL('./server.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./demo-server.cjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  plugins: [{
    name: 'memory-store',
    setup(b) { b.onResolve({ filter: /^\.\/store$/ }, () => ({ path: memoryStore })); }
  }]
});
console.log('Built dev/demo-server.cjs');
