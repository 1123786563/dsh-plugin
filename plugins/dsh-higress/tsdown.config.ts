import { defineConfig } from 'tsdown'

// Host-provided packages stay external so the plugin shares the running dsh
// process's own module instances (registerAdapter and the LlmAdapter contract
// have instanceof semantics). eventsource-parser is NOT bundled either: it is
// not a host package, so it stays a bare import in lib/index.js and resolves
// through the plugin's own dependencies.
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  outExtensions: () => ({ js: '.js' }),
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/schemastery',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-timeout',
    ],
  },
})
