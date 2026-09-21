import type { Plugin } from 'vite';
import { createApiHandler } from './api';

export function busScaleApi(dbPath = 'bus-scale.sqlite'): Plugin {
  return {
    name: 'bus-scale-api',
    configureServer(server) {
      const handler = createApiHandler(dbPath);
      server.middlewares.use((req, res, next) => {
        void handler(req, res, next);
      });
    },
  };
}
