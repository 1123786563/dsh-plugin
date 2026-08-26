/**
 * Build the browser half into the client module system's lazy-CJS factory
 * artifact (see plugins/dsh-openmeter/scripts/build-client.mjs for the
 * format contract).
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
  outfile: 'client.js',
  legalComments: 'none',
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
    + '  id: "dsh-higress",' + NL
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
