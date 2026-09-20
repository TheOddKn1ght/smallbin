import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, expect as browserExpect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import jsQR from "jsqr";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApplication, type Application } from "../../src/server/app";
import { createStaticHandler } from "../../src/http";
import { LIMITS } from "../../src/shared/config";
import { encryptBin } from "../../src/shared/crypto";

let browser: Browser;
let context: BrowserContext;
let page: Page;
let app: Application;
let server: ReturnType<typeof Bun.serve>;
let root: string;
let origin: string;
let now: number;
const errors: string[] = [];
const networkUrls: string[] = [];
const wireUrls: string[] = [];

beforeAll(async () => {
  if (!(await Bun.file("dist/client/index.html").exists())) throw new Error("Run bun run build before browser tests.");
  browser = await chromium.launch({ headless: true });
});
beforeEach(async () => {
  now = Date.now();
  networkUrls.length = 0;
  wireUrls.length = 0;
  root = await mkdtemp(join(tmpdir(), "smallbin-browser-"));
  const staticHandler = await createStaticHandler(resolve("dist/client"));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: LIMITS.maxEnvelopeBytes + 1, idleTimeout: 120,
    fetch(request, server) {
      wireUrls.push(request.url);
      const path = new URL(request.url).pathname;
      return path.startsWith("/api/") || path === "/healthz" ? app.handle(request, server.requestIP(request)?.address) : staticHandler(request);
    },
  });
  origin = `http://127.0.0.1:${server.port}`;
  app = await createApplication({ dataDir: join(root, "data"), publicOrigin: origin, now: () => now, capacities: { attemptsPerHour: 100 } });
  context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, permissions: ["clipboard-read", "clipboard-write"] });
  page = await context.newPage();
  page.on("request", request => networkUrls.push(request.url()));
  errors.length = 0;
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  await browserExpect(page.getByRole("button", { name: "Create private link", exact: true })).toBeEnabled();
});
afterEach(async () => {
  await context?.close();
  await server?.stop(true);
  await app?.shutdown();
  await rm(root, { recursive: true, force: true });
  expect(errors).toEqual([]);
});
afterAll(async () => { await browser?.close(); });

async function share(text: string, file?: { path: string }) {
  await page.getByLabel("Your message").fill(text);
  if (file) await page.locator("#bin-file").setInputFiles(file.path);
  await page.getByRole("button", { name: "Create private link", exact: true }).click();
  const link = page.getByLabel("Private share link");
  await browserExpect(link).toBeVisible({ timeout: 120_000 });
  return link.inputValue();
}

test("real encrypted text + file sharing, clipboard, QR, and zero plaintext transmission", async () => {
  const text = "SECRET-SENTINEL-αβ-<script>window.compromised=true</script>";
  const filename = "private-financial-note.txt";
  const fileText = "ATTACHMENT-SENTINEL-ONLY-RECIPIENTS-SEE-THIS";
  const file = join(root, filename); await Bun.write(file, fileText);
  const requests: { url: string; body: Buffer | null }[] = [];
  page.on("request", request => requests.push({ url: request.url(), body: request.postDataBuffer() }));
  const link = await share(text, { path: file });
  const key = link.split("#")[1]!;
  await page.getByRole("button", { name: "Copy link", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
  await page.getByRole("button", { name: "Show QR code" }).click();
  const qrPixels = await page.getByRole("img", { name: "QR code containing the complete private share link" }).evaluate(async element => {
    const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 512;
    const ctx = canvas.getContext("2d")!;
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(element))}`;
    await image.decode(); ctx.drawImage(image, 0, 0, 512, 512);
    return Array.from(ctx.getImageData(0, 0, 512, 512).data);
  });
  expect(jsQR(new Uint8ClampedArray(qrPixels), 512, 512)?.data).toBe(link);
  await page.goto(link);
  await browserExpect(page.locator(".received-text")).toHaveText(text);
  expect(await page.evaluate(() => (window as unknown as { compromised?: boolean }).compromised)).toBeUndefined();
  await page.getByRole("button", { name: "Copy text", exact: true }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(text);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download file", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(filename);
  expect(await Bun.file((await download.path())!).text()).toBe(fileText);
  for (const request of requests) {
    expect(new URL(request.url).origin).toBe(origin);
    // Browser request events may expose the navigation fragment; wire requests never include it.
    if (request.url.includes("/api/")) expect(request.url).not.toContain(key);
    if (request.body) for (const secret of [text, fileText, filename, key]) expect(request.body.includes(Buffer.from(secret))).toBe(false);
  }
  expect(await context.cookies()).toEqual([]);
  for (const url of networkUrls) if (/^https?:/.test(url)) expect(new URL(url).origin).toBe(origin);
  for (const url of wireUrls) { expect(url).not.toContain("#"); expect(url).not.toContain(key); }
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  const diskFiles = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: join(root, "data"), onlyFiles: true }));
  for (const path of diskFiles) {
    const bytes = Buffer.from(await Bun.file(join(root, "data", path)).arrayBuffer());
    for (const secret of [text, fileText, filename, key]) expect(bytes.includes(Buffer.from(secret))).toBe(false);
  }
});

test("missing key, wrong key, tampering, and expiry fail without displaying content", async () => {
  const link = await share("private message that should remain hidden");
  await page.goto(link.split("#")[0]!);
  await browserExpect(page.getByRole("alert")).toContainText("key is missing");
  const wrong = await encryptBin({ text: "wrong" });
  await page.goto(`${link.split("#")[0]}#${wrong.key}`);
  await page.reload();
  await browserExpect(page.getByRole("alert")).toContainText("couldn’t be decrypted");
  const blob = (await readdir(join(root, "data", "blobs")))[0]!;
  const path = join(root, "data", "blobs", blob);
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer()); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; await Bun.write(path, bytes);
  await page.goto(link); await page.reload();
  await browserExpect(page.getByRole("alert")).toContainText("couldn’t be decrypted");
  now += 300_001;
  await page.reload();
  await browserExpect(page.getByRole("alert")).toContainText("unavailable");
  expect(await page.locator(".received-text").count()).toBe(0);
});

test("mobile keyboard flow, validation, privacy, and screenshots", async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Create private link", exact: true }).click();
  await browserExpect(page.getByRole("alert")).toContainText("Add some text");
  await page.getByLabel("Your message").focus();
  await page.keyboard.type("A message created with the keyboard.");
  await page.keyboard.press("Tab");
  await browserExpect(page.getByRole("button", { name: /Drop a file/ })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "test-results/smallbin-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.screenshot({ path: "test-results/smallbin-desktop.png", fullPage: true });
  await page.getByRole("link", { name: "Privacy", exact: true }).click();
  await browserExpect(page.getByRole("heading", { name: "Your content is encrypted on your device." })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("cancelled upload keeps draft and allows retry", async () => {
  let seen!: () => void; const intercepted = new Promise<void>(resolve => { seen = resolve; });
  let release!: () => void; const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/bins?*", async route => { seen(); await delayed; await route.abort().catch(() => {}); });
  await page.getByLabel("Your message").fill("keep my draft");
  await page.getByRole("button", { name: "Create private link", exact: true }).click();
  await intercepted;
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  release();
  await browserExpect(page.getByLabel("Your message")).toHaveValue("keep my draft");
  await browserExpect(page.getByRole("status")).toContainText("Cancelled");
  await page.unroute("**/api/bins?*");
  await share("keep my draft");
});

test("100 MB file plus 1 MB text round-trips through the real browser", async () => {
  const path = join(root, "maximum.bin");
  const contents = new Uint8Array(LIMITS.maxFileBytes).fill(71); contents[0] = 1; contents[contents.length - 1] = 255;
  const expectedHash = new Bun.CryptoHasher("sha256").update(contents).digest("hex");
  await Bun.write(path, contents);
  const text = "a".repeat(LIMITS.maxTextBytes);
  const link = await share(text, { path });
  await page.goto(link);
  await browserExpect(page.getByRole("button", { name: "Download file", exact: true })).toBeVisible({ timeout: 120_000 });
  expect(await page.locator(".received-text").textContent()).toBe(text);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download file", exact: true }).click();
  const download = await downloading;
  const downloaded = await Bun.file((await download.path())!).arrayBuffer();
  expect(downloaded.byteLength).toBe(LIMITS.maxFileBytes);
  expect(new Bun.CryptoHasher("sha256").update(downloaded).digest("hex")).toBe(expectedHash);
}, 180_000);
