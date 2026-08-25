import { defineConfig } from 'tsdown'

// Host-provided packages stay external so the plugin shares the running dsh
// process's own modules (the profile flat fallback resolves them at boot).
// zod is bundled: it is this plugin's own runtime dependency.
export default defineConfig({
  entry: ['src/index.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  outExtensions: () => ({ js: '.js' }),
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-brand',
      '@deepseek-ai/dsh-invariants',
      '@deepseek-ai/dsh-storage-domain',
      '@deepseek-ai/dsh-tools',
    ],
  },
})
