import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Свои каналы событий: живой воркер на том же Redis не должен исполнять тестовые события.
    env: { EVENTS_CHANNEL_PREFIX: "test-events" },
  },
});
