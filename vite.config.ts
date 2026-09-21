import { defineConfig } from 'vite';
import { apiPlugin } from './src/server/api.js';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5243,
    strictPort: true
  },
  plugins: [apiPlugin()]
});
