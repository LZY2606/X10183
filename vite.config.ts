import { defineConfig, type Plugin } from 'vite';
import { handleApi } from './server/api.js';
import { db } from './server/db.js';
import { seed } from './server/seed.js';

function apiPlugin(): Plugin {
  return {
    name: 'bus-scale-api',
    configureServer(server) {
      db();
      seed();
      server.middlewares.use(async (req, res, next) => {
        try {
          const handled = await handleApi(req, res);
          if (!handled) next();
        } catch (e) {
          next(e);
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [apiPlugin()],
  server: { host: '127.0.0.1', port: 5243, strictPort: true }
});
