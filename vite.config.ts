/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { busScaleApi } from './src/server/plugin';

export default defineConfig({
  plugins: [react(), busScaleApi()],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
