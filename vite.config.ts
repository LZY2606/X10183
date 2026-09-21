import { defineConfig, type Plugin } from 'vite';
import { apiMiddleware } from './src/server/api';

function busScaleApi(): Plugin {
  return {
    name: 'bus-scale-api',
    configureServer(server) {
      server.middlewares.use('/api', apiMiddleware());
    },
  };
}

export default defineConfig({
  plugins: [busScaleApi()],
});
