import { defineConfig } from 'tsdown'

// Host-provided packages and the vendored multi-tenant runtime stay external
// so the plugin shares the running dsh process's own module instances (the
// capability tokens and runtime registries must be the profile's, not a
// bundled copy). jose is bundled — the host does not provide it.
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  outExtensions: () => ({ js: '.js' }),
  deps: {
    neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/schemastery', 'dsh-multi-tenant'],
  },
})
