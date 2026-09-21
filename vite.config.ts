import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { createApiMiddleware } from './server/api';

export default defineConfig({
  plugins: [
    react(),
    {
      name: 'bus-scale-api',
      configureServer(server) {
        server.middlewares.use('/api', createApiMiddleware());
      },
    },
  ],
  test: {
    include: ['tests/**/*.test.ts'],
  },
});
