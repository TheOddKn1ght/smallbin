import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStaticHandler, PAGE_HEADERS } from "../../src/http";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "smallbin-assets-")); roots.push(root);
  await Bun.write(join(root, "index.html"), "<!doctype html><title>Smallbin</title>");
  await Bun.write(join(root, "app.js"), "void 0");
  await Bun.write(join(root, "secret.sqlite"), "never serve me");
  return createStaticHandler(root);
}
test("serves all client pages with restrictive headers", async () => {
  const handle = await fixture();
  for (const route of ["/", "/privacy", "/b/abcdefghijklmnopqrstuv"]) {
    const response = handle(new Request(`https://smallbin.test${route}`));
    expect(response.status).toBe(200);
    for (const [name, value] of Object.entries(PAGE_HEADERS)) expect(response.headers.get(name)).toBe(value);
    expect(await response.text()).toContain("Smallbin");
  }
});
test("static asset handling rejects files outside build assets and unsupported methods", async () => {
  const handle = await fixture();
  expect(handle(new Request("https://smallbin.test/app.js")).headers.get("Content-Type")).toContain("javascript");
  expect(await handle(new Request("https://smallbin.test/", { method: "HEAD" })).text()).toBe("");
  for (const route of ["/secret.sqlite", "/.env", "/unknown", "/b/bad"]) expect(handle(new Request(`https://smallbin.test${route}`)).status).toBe(404);
  expect(handle(new Request("https://smallbin.test/", { method: "POST" })).status).toBe(405);
});
test("startup fails rather than serving missing frontend", async () => {
  const root = await mkdtemp(join(tmpdir(), "smallbin-empty-")); roots.push(root);
  await expect(createStaticHandler(root)).rejects.toThrow("Frontend assets");
});
