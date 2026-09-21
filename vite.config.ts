import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { busScaleApi } from "./src/server/api";

export default defineConfig({
  plugins: [react(), busScaleApi()],
  server: {
    host: "127.0.0.1",
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
