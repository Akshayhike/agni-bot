#!/usr/bin/env node
/**
 * Screenshot the sidebar footer so the design can be compared to the mock.
 *
 *   AGNI_TOKEN=… node scripts/footer-shot.mjs
 */
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webURL = process.env.WEB_URL ?? "http://127.0.0.1:5173";
const rawServer = process.env.AGNI_URL ?? "127.0.0.1:8787";
const token = process.env.AGNI_TOKEN?.trim();
if (!token) {
  console.error("AGNI_TOKEN is required");
  process.exit(2);
}
const server = rawServer.replace(/^wss?:\/\//, "").replace(/^https?:\/\//, "").replace(/\/ws$/, "");

const here = dirname(fileURLToPath(import.meta.url));
const evidence = resolve(here, "../../../artifacts/web-e2e");
await mkdir(evidence, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 760 } });
try {
  await page.goto(webURL, { waitUntil: "networkidle" });
  await page.getByLabel("Agni server address").fill(server);
  await page.getByPlaceholder("Paste the token shown by the command").fill(token);
  await page.getByPlaceholder("This Browser").fill("Nachiketh Reddy");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.locator(".composer-input").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: resolve(evidence, "footer-01-window.png") });
  await page.locator(".sidebar-footer").screenshot({ path: resolve(evidence, "footer-02-strip.png") });
  await page.locator(".sidebar").screenshot({ path: resolve(evidence, "footer-03-sidebar.png") });
  console.log("ok");
} finally {
  await browser.close();
}
