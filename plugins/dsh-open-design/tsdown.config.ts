import { defineConfig } from 'tsdown'

// Host-provided packages stay external so the plugin shares the running dsh
// process's own modules (the profile flat fallback resolves them at boot).
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  outExtensions: () => ({ js: '.js' }),
  deps: {
    neverBundle: ['@deepseek-ai/cordis', '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/schemastery'],
  },
})
