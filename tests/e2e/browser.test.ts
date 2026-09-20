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

async function share(text: string, files: string[] = []) {
  await page.getByLabel("Your message").fill(text);
  if (files.length) await page.locator("#bin-file").setInputFiles(files);
  await page.getByRole("button", { name: "Create private link", exact: true }).click();
  const link = page.getByLabel("Private share link");
  await browserExpect(link).toBeVisible({ timeout: 120_000 });
  return link.inputValue();
}

test("real encrypted text + multiple files, clipboard, QR, and zero plaintext transmission", async () => {
  const text = "SECRET-SENTINEL-αβ-<script>window.compromised=true</script>";
  const filename = "private-financial-note.txt";
  const fileText = "ATTACHMENT-SENTINEL-ONLY-RECIPIENTS-SEE-THIS";
  const file = join(root, filename); await Bun.write(file, fileText);
  const requests: { url: string; body: Buffer | null }[] = [];
  page.on("request", request => requests.push({ url: request.url(), body: request.postDataBuffer() }));
  const secondName = "second-secret.bin";
  const secondText = "SECOND-FILE-PRIVATE-SENTINEL";
  const secondPath = join(root, secondName); await Bun.write(secondPath, secondText);
  const link = await share(text, [file, secondPath]);
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
  await browserExpect(page.locator(".received-attachment")).toHaveCount(2);
  for (const [name, contents] of [[filename, fileText], [secondName, secondText]] as const) {
    const downloading = page.waitForEvent("download");
    await page.locator(".received-attachment").filter({ hasText: name }).getByRole("button", { name: /^Download/ }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(name);
    expect(await Bun.file((await download.path())!).text()).toBe(contents);
  }
  for (const request of requests) {
    expect(new URL(request.url).origin).toBe(origin);
    // Browser request events may expose the navigation fragment; wire requests never include it.
    if (request.url.includes("/api/")) expect(request.url).not.toContain(key);
    if (request.body) for (const secret of [text, fileText, filename, secondName, secondText, key]) expect(request.body.includes(Buffer.from(secret))).toBe(false);
  }
  expect(await context.cookies()).toEqual([]);
  for (const url of networkUrls) if (/^https?:/.test(url)) expect(new URL(url).origin).toBe(origin);
  for (const url of wireUrls) { expect(url).not.toContain("#"); expect(url).not.toContain(key); }
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  const diskFiles = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: join(root, "data"), onlyFiles: true }));
  for (const path of diskFiles) {
    const bytes = Buffer.from(await Bun.file(join(root, "data", path)).arrayBuffer());
    for (const secret of [text, fileText, filename, secondName, secondText, key]) expect(bytes.includes(Buffer.from(secret))).toBe(false);
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
  await browserExpect(page.getByRole("button", { name: /Drop/ })).toBeFocused();
  const firstPath = join(root, "notes.txt"); const secondPath = join(root, "remove-me.txt");
  const thirdName = "a-long-attachment-name-that-should-fit-on-a-mobile-screen-without-overflow.txt";
  const thirdPath = join(root, thirdName);
  await Bun.write(firstPath, "first"); await Bun.write(secondPath, "second"); await Bun.write(thirdPath, "third");
  await page.locator("#bin-file").setInputFiles([firstPath, secondPath]);
  await page.locator("#bin-file").setInputFiles(thirdPath);
  await page.getByRole("button", { name: /Remove.*remove-me/ }).click();
  await browserExpect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  await browserExpect(page.getByText(thirdName, { exact: true })).toBeVisible();
  await browserExpect(page.getByText("remove-me.txt", { exact: true })).toHaveCount(0);
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
  const paths = [join(root, "keep-first.txt"), join(root, "keep-second.txt")];
  await Bun.write(paths[0]!, "first"); await Bun.write(paths[1]!, "second");
  await page.locator("#bin-file").setInputFiles(paths);
  await page.getByRole("button", { name: "Create private link", exact: true }).click();
  await intercepted;
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  release();
  await browserExpect(page.getByLabel("Your message")).toHaveValue("keep my draft");
  for (const name of ["keep-first.txt", "keep-second.txt"]) await browserExpect(page.getByText(name, { exact: true })).toBeVisible();
  await browserExpect(page.getByRole("status")).toContainText("Cancelled");
  await page.unroute("**/api/bins?*");
  await share("keep my draft");
});

test("files totaling exactly 100 MB plus 1 MB text round-trip; an extra byte is rejected", async () => {
  const firstPath = join(root, "first-half.bin");
  const secondPath = join(root, "second-half.bin");
  const first = new Uint8Array(LIMITS.maxFileBytes / 2).fill(71);
  const second = new Uint8Array(LIMITS.maxFileBytes / 2).fill(33);
  first[0] = 1; second[second.length - 1] = 255;
  const files = [
    { path: firstPath, name: "first-half.bin", hash: new Bun.CryptoHasher("sha256").update(first).digest("hex") },
    { path: secondPath, name: "second-half.bin", hash: new Bun.CryptoHasher("sha256").update(second).digest("hex") },
  ];
  await Bun.write(firstPath, first); await Bun.write(secondPath, second);
  await page.locator("#bin-file").setInputFiles([firstPath, secondPath]);
  const extraPath = join(root, "one-byte-over.bin"); await Bun.write(extraPath, new Uint8Array([7]));
  let uploads = 0;
  page.on("request", request => { if (request.method() === "POST") uploads++; });
  await page.locator("#bin-file").setInputFiles(extraPath);
  await browserExpect(page.getByRole("alert")).toContainText("100 MB");
  expect(uploads).toBe(0);
  await browserExpect(page.getByText("one-byte-over.bin", { exact: true })).toHaveCount(0);
  const text = "a".repeat(LIMITS.maxTextBytes);
  const link = await share(text);
  await page.goto(link);
  await browserExpect(page.locator(".received-attachment")).toHaveCount(2, { timeout: 120_000 });
  expect(await page.locator(".received-text").textContent()).toBe(text);
  for (const file of files) {
    const downloading = page.waitForEvent("download");
    await page.locator(".received-attachment").filter({ hasText: file.name }).getByRole("button", { name: /^Download/ }).click();
    const download = await downloading;
    const downloaded = await Bun.file((await download.path())!).arrayBuffer();
    expect(download.suggestedFilename()).toBe(file.name);
    expect(downloaded.byteLength).toBe(LIMITS.maxFileBytes / 2);
    expect(new Bun.CryptoHasher("sha256").update(downloaded).digest("hex")).toBe(file.hash);
  }
}, 180_000);

test("existing v1 single-file links still open with the updated frontend", async () => {
  // Build the previous wire format independently of the current encryptor.
  const encoder = new TextEncoder();
  const text = "Saved before multiple attachments were supported.";
  const filename = "legacy-note.txt";
  const attachment = encoder.encode("original attachment bytes");
  const message = encoder.encode(text);
  const metadata = encoder.encode(JSON.stringify({ textLength: message.length, file: { name: filename, type: "text/plain", size: attachment.length } }));
  const plaintext = new Uint8Array(4 + metadata.length + message.length + attachment.length);
  new DataView(plaintext.buffer).setUint32(0, metadata.length, false);
  plaintext.set(metadata, 4); plaintext.set(message, 4 + metadata.length); plaintext.set(attachment, 4 + metadata.length + message.length);
  const header = new Uint8Array([0x53, 0x42, 0x49, 0x4e, 1]);
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header }, key, plaintext);
  const payload = new Uint8Array(17 + ciphertext.byteLength);
  payload.set(header); payload.set(iv, 5); payload.set(new Uint8Array(ciphertext), 17);
  const response = await fetch(`${origin}/api/bins?ttlSeconds=300`, {
    method: "POST", headers: { origin, "content-type": "application/octet-stream" }, body: payload,
  });
  expect(response.status).toBe(201);
  const { id } = await response.json() as { id: string };
  await page.goto(`${origin}/b/${id}#${Buffer.from(rawKey).toString("base64url")}`);
  await browserExpect(page.locator(".received-text")).toHaveText(text);
  await browserExpect(page.locator(".received-attachment")).toHaveCount(1);
  const downloading = page.waitForEvent("download");
  await page.locator(".received-attachment").getByRole("button", { name: /^Download/ }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(filename);
  expect(await Bun.file((await download.path())!).text()).toBe("original attachment bytes");
});
