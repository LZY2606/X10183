import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { apiPlugin } from './src/server/plugin';

export default defineConfig({
  plugins: [react(), apiPlugin()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
});
