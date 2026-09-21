import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { apiMiddleware } from "./src/server/middleware";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "bus-scale-api",
      configureServer(server) {
        server.middlewares.use("/api", apiMiddleware);
      },
    },
  ],
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
