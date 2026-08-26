#!/usr/bin/env node
/**
 * Build the casdoor auth plugin in place (services/nocobase/plugin-auth-casdoor):
 *   dist/server/index.js  — CJS, @nocobase/* external (resolved from the app)
 *   dist/client/index.js  — CJS, @nocobase/* + antd + react external
 *   dist/LICENSE          — none needed
 * Run from anywhere: pnpm --filter dsh-nocobase-service build
 */

import { build } from 'esbuild'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = resolve(root, 'plugin-auth-casdoor')
const dist = resolve(plugin, 'dist')
const NL = String.fromCharCode(10)

await rm(dist, { recursive: true, force: true })

// Anything the host runtime provides stays external. The plugin declares zero
// runtime dependencies on purpose: no npm install inside the container.
const serverExternal = ['@nocobase/*', '@formily/*', 'lodash', 'lodash/*']
const clientExternal = [
  '@nocobase/*',
  '@formily/*',
  'antd',
  'antd/*',
  'react',
  'react-dom',
  'react-router-dom',
  'lodash',
  'lodash/*',
]

await build({
  entryPoints: [resolve(plugin, 'src/server/index.ts')],
  outfile: resolve(dist, 'server/index.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: serverExternal,
  logLevel: 'info',
})

// The NocoBase web shell loads external plugin client bundles through
// RequireJS. esbuild has no AMD output, so the CJS bundle is wrapped in the
// AMD simplified-CommonJS form: RequireJS scans the factory source for
// require("...") literals (the @nocobase/*, antd, react externals) and
// resolves them against the shell's config.
const clientBuild = await build({
  entryPoints: [resolve(plugin, 'src/client/index.tsx')],
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2019',
  jsx: 'automatic',
  external: clientExternal,
  write: false,
  logLevel: 'info',
})
let clientBody = ''
for (const file of clientBuild.outputFiles ?? []) {
  if (!file.path.endsWith('.map')) clientBody = file.text
}
if (clientBody.length === 0) throw new Error('client build produced no JS output')
await mkdir(resolve(dist, 'client'), { recursive: true })
await writeFile(
  resolve(dist, 'client/index.js'),
  'define(function (require, exports, module) {' + NL + clientBody + NL + '});' + NL,
  'utf8',
)

console.log(`built ${dist.replace(root + '/', '')}/server/index.js + client/index.js`)
