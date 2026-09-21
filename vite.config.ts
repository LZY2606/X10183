import { defineConfig } from 'vite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { apiPlugin } from './src/server/api.js';
import { openDatabase } from './src/server/db.js';
import { isSeeded, seed } from './src/server/seed.js';

mkdirSync(join(process.cwd(), 'data'), { recursive: true });
const handle = openDatabase(join(process.cwd(), 'data', 'bus-scale.sqlite'));
if (!isSeeded(handle)) seed(handle);

export default defineConfig({
  root: 'src/client',
  plugins: [apiPlugin(handle)],
  server: {
    host: '127.0.0.1',
    port: 5243,
    strictPort: true,
  },
  build: {
    outDir: join(process.cwd(), 'dist'),
    emptyOutDir: true,
  },
});
