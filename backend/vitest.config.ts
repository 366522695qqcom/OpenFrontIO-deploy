import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Match the `resources/*` path alias from tsconfig.json. Without this,
      // vitest cannot resolve imports like `resources/tribeNameThemes.json`.
      resources: path.resolve(__dirname, "resources"),
    },
  },
  test: {
    environment: "node",
    globals: true,
    env: {
      // ServerEnv reads these at static-initialization / call time and throws
      // when missing. Mirror the `npm run dev` values so tests can run standalone.
      GAME_ENV: "dev",
      NUM_WORKERS: "2",
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      DOMAIN: "localhost",
      GIT_COMMIT: "TEST",
      API_KEY: "TEST",
      ADMIN_BOT_API_KEY: "TEST",
    },
  },
});
