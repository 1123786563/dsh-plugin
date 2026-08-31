/**
 * Build the browser half into the client module system's lazy-CJS factory
 * artifact: one classic script whose execution only REGISTERS the factory
 * (window.__ModuleLoader__.load), with every module-body side effect inside
 * the factory closure. Matches the format the dsh web shell's module loader
 * materializes (see packages/client/modules in deepseek-harness).
 */

import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const NL = String.fromCharCode(10)
const root = resolve(new URL('.', import.meta.url).pathname, '..')
const outfile = resolve(root, 'lib/client.js')

const result = await build({
  entryPoints: [resolve(root, 'src/client/index.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: 'external',
  // In-memory output still needs a path to name the external source map.
  outfile: 'client.js',
  legalComments: 'none',
  // Only shell-seeded baseline externals: React and its jsx runtime. Every
  // service the plugin uses (slots, locale, settingsScope, betterSidebar)
  // arrives through cordis injection, never through a module require.
  external: ['react', 'react/jsx-runtime'],
  write: false,
  logLevel: 'info',
})

let body = ''
let map = ''
for (const file of result.outputFiles ?? []) {
  if (file.path.endsWith('.map')) map = file.text
  else body = file.text
}
if (body.length === 0) throw new Error('build-client: no JS output produced')

await mkdir(dirname(outfile), { recursive: true })
await writeFile(
  outfile,
  'window.__ModuleLoader__.load({' + NL
    + '  id: "dsh-plane",' + NL
    + '  factory: (require) => {' + NL
    + '    var module = { exports: {} };' + NL
    + '    var exports = module.exports;' + NL
    + body + NL
    + '    return module.exports;' + NL
    + '  },' + NL
    + '});' + NL
    + (map.length === 0 ? '' : '//# sourceMappingURL=client.js.map' + NL),
  'utf8',
)
if (map.length > 0) {
  await writeFile(outfile + '.map', map, 'utf8')
}

// The standalone board page: one self-contained IIFE shipping its own React,
// served by the host half at /plugins/dsh-plane/app (no module loader, no
// host runtime dependency).
const appRoot = resolve(root, 'lib/app.js')
await build({
  entryPoints: [resolve(root, 'src/app/main.tsx')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: false,
  outfile: appRoot,
  legalComments: 'none',
  minify: true,
  logLevel: 'info',
})