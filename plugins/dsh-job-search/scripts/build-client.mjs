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
  entryPoints: [resolve(root, 'src/client/index.ts')],
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
  // service the plugin uses (slots, locale) arrives through cordis
  // injection, never through a module require. CSS modules are inlined.
  external: ['react', 'react/jsx-runtime'],
  loader: { '.module.css': 'local-css' },
  write: false,
  logLevel: 'info',
})

let body = ''
let map = ''
let css = ''
for (const file of result.outputFiles ?? []) {
  if (file.path.endsWith('.map')) map = file.text
  else if (file.path.endsWith('.css')) css = file.text
  else body = file.text
}
if (body.length === 0) throw new Error('build-client: no JS output produced')

await mkdir(dirname(outfile), { recursive: true })
await writeFile(
  outfile,
  'window.__ModuleLoader__.load({' + NL
    + '  id: "dsh-job-search",' + NL
    + '  factory: (require) => {' + NL
    + '    var module = { exports: {} };' + NL
    + '    var exports = module.exports;' + NL
    // CSS Modules land in one collected stylesheet: inject it once, the
    // first time this factory runs, so the scoped class names resolve.
    + '    if (!document.getElementById("dsh-job-search-styles")) {' + NL
    + '      var style = document.createElement("style");' + NL
    + '      style.id = "dsh-job-search-styles";' + NL
    + '      style.textContent = ' + JSON.stringify(css) + ';' + NL
    + '      document.head.appendChild(style);' + NL
    + '    }' + NL
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
