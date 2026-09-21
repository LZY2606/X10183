import { defineConfig } from "vitest/config";

export default defineConfig({
  root: "src/client",
  server: {
    host: "127.0.0.1",
    port: 5243,
    strictPort: true
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 20000
  }
});
