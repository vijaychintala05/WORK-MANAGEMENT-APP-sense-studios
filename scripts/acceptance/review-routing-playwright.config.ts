import { defineConfig } from "@playwright/test";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import base from "../../playwright.config.js";
import { recoveryTestSource } from "../../apps/api/src/recovery-test-target.js";

const root = resolve(process.cwd());
const runId = process.env.SENSE_REVIEW_ROUTING_TEST_RUN ?? "";
if (!/^\d{13}_[a-f0-9]{12}$/.test(runId) || process.env.NODE_ENV !== "test") throw new Error("Owned review120 browser fixture required");
const directory = resolve(root, ".env.review-routing-20261023", runId);
if (realpathSync(directory).toLowerCase() !== directory.toLowerCase()) throw new Error("Owned fixture path mismatch");
const state = JSON.parse(readFileSync(resolve(directory, "private.json"), "utf8"));
if (state.environment.DATABASE_URL !== process.env.DATABASE_URL || state.source.migrations.length !== 120 || JSON.stringify(state.source) !== JSON.stringify(recoveryTestSource(root))) throw new Error("Exact reviewed browser fixture and source required");
const quote = (value: string) => `"${value.replaceAll('"', '')}"`;
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({
  ...base,
  testDir: resolve(root, "tests/e2e"),
  outputDir: resolve(directory, "browser-artifacts"),
  reporter: [["list"], ["json", { outputFile: resolve(directory, "browser-results.json") }]],
  webServer: servers.map((server, index) => ({
    ...server,
    reuseExistingServer: false,
    cwd: index === 0 ? root : resolve(root, "apps/web"),
    command: index === 0
      ? `${quote(process.execPath)} ${quote(resolve(root, "apps/api/dist/main.js"))}`
      : `${quote(process.execPath)} ${quote(resolve(root, "apps/web/node_modules/vite/bin/vite.js"))} preview --host 127.0.0.1 --port 58431 --strictPort`
  }))
});
