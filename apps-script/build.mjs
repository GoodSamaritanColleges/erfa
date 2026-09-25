import { build } from 'esbuild';
import { mkdir, copyFile, readFile } from 'node:fs/promises';

const appsScriptEntrypointWrappers = `
// Apps Script discovers only top-level function declarations. Keep the
// implementation bundle private and expose just the supported entry points.
function doGet(e) {
  return globalThis.__erfaEntrypoints.doGet(e);
}

function doPost(e) {
  return globalThis.__erfaEntrypoints.doPost(e);
}

function setupDatabase() {
  return globalThis.__erfaEntrypoints.setupDatabase();
}

function bootstrapAdmin(email, fullName) {
  return globalThis.__erfaEntrypoints.bootstrapAdmin(email, fullName);
}

// Manual editor-only maintenance; intentionally absent from API dispatch.
function resetTestDataForProduction(confirmation) {
  return globalThis.__erfaEntrypoints.resetTestDataForProduction(confirmation);
}

function runProductionTestDataReset_ONCE() {
  return resetTestDataForProduction('RESET TEST DATA');
}
`;

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/Code.js',
  bundle: true,
  format: 'iife',
  platform: 'neutral',
  target: 'es2021',
  legalComments: 'none',
  minify: false,
  footer: { js: appsScriptEntrypointWrappers }
});
await copyFile('appsscript.json', 'dist/appsscript.json');

const bundle = await readFile('dist/Code.js', 'utf8');
const iifeEnd = bundle.lastIndexOf('})();');
const requiredEntrypoints = ['doGet', 'doPost', 'setupDatabase', 'bootstrapAdmin', 'resetTestDataForProduction', 'runProductionTestDataReset_ONCE'];
if (iifeEnd < 0 || requiredEntrypoints.some((name) => bundle.indexOf(`function ${name}(`, iifeEnd) < 0)) {
  throw new Error('Apps Script entry-point wrappers were not emitted at top level.');
}
