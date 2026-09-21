import { defineConfig, type Plugin } from 'vitest/config';

function nodeBuiltinPlugin(): Plugin {
  return {
    name: 'node-builtin-sqlite',
    enforce: 'pre',
    resolveId(source) {
      if (source === 'node:sqlite' || source === 'sqlite') {
        return { id: 'node:sqlite', external: true };
      }
      return null;
    }
  };
}

export default defineConfig({
  plugins: [nodeBuiltinPlugin()],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20000
  }
});
