import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@paperclipai/plugin-paperclip-observability",
    include: ["tests/**/*.spec.ts"],
    environment: "node",
  },
});
