import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const PORT = 4173;

export default defineConfig({
  testDir: ".",
  testMatch: "*.smoke.ts",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: process.env.CI === "true",
  retries: 0,
  timeout: 120_000,
  reporter: "list",
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "bun --no-env-file apps/cli/src/main.ts serve",
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    // Every EnvSchema variable is set (blank = default) and `--no-env-file` skips `.env`, so neither the shell nor `.env` changes the replay.
    env: {
      PORT: String(PORT),
      HOST: "",
      ALLOWED_HOSTS: "",
      DATA_DIR: ":memory:",
      DEMO_ONLY: "true",
      // Unreachable on purpose: demos use their own ofac.json, so the 29 MB SDN list is never downloaded.
      OFAC_SDN_URL: "http://127.0.0.1:9/sdn.xml",
      ETHERSCAN_API_KEY: "",
      ETHERSCAN_RPS: "",
      TRONSCAN_API_KEYS: "",
      TRONSCAN_KEY_INTERVAL_MS: "",
      TRONSCAN_GLOBAL_INTERVAL_MS: "",
      EXPLORER_MAX_PAGES: "",
      ENGINE_CONCURRENCY: "",
      FOT_LABELS_PATH: "",
      FOT_POLICY_PATH: "",
      OFAC_REFRESH_HOURS: "",
    },
  },
});
