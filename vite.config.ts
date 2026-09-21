import { defineConfig, type PluginOption } from 'vitest/config';
import { createApiMiddleware } from './src/server/api.js';

function busScaleApiPlugin(dbPath?: string): PluginOption {
  return {
    name: 'bus-scale-api',
    configureServer(server) {
      server.middlewares.use(createApiMiddleware({ dbPath }));
    },
  };
}

export default defineConfig({
  plugins: [busScaleApiPlugin(process.env.BUSSCALE_DB)],
  server: { host: '127.0.0.1', port: 5243, strictPort: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
  },
});
