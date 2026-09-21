import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { handleApi } from './src/server/api';
import { seedIfEmpty } from './src/server/seed';

function busScalePlugin(): Plugin {
  return {
    name: 'bus-scale-api',
    configureServer(server) {
      seedIfEmpty();
      server.middlewares.use(async (req, res, next) => {
        const handled = await handleApi(req, res);
        if (!handled) next();
      });
    },
  };
}

export default defineConfig({
  plugins: [busScalePlugin()],
  server: { host: '127.0.0.1', port: 5243, strictPort: true },
  test: {
    environment: 'node',
    pool: 'forks',
    globalSetup: ['./test/global-setup.ts'],
  },
});
