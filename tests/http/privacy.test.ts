import { expect, test } from "bun:test";
import { renderPrivacyPage } from "../../src/privacy-page";

const template = '<!doctype html><html lang="en"><head><title>Smallbin</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/app.css"><link rel="modulepreload" href="/app.js"><script type="module" src="/app.js"></script></head><body><div id="root"></div><noscript>JavaScript required</noscript></body></html>';

test("privacy document contains the shared layout and disclosures without a JavaScript dependency", async () => {
  const html = await renderPrivacyPage(template);
  expect(html).toContain("<title>Privacy | Smallbin</title>");
  expect(html).toContain("<h1>Privacy</h1>");
  for (const content of ["AES-256-GCM", "temporary throttling", "Expiry stops new downloads.", "compromised server", "physical erasure"]) expect(html).toContain(content);
  expect(html).toContain('href="/app.css"');
  expect(html).toContain('href="/favicon.svg"');
  expect(html).toContain('href="/privacy" aria-current="page"');
  expect(html).toContain('href="#main"');
  expect(html).not.toMatch(/<script|<noscript|modulepreload|app\.js|https?:\/\//);
});

test("development privacy document includes its stylesheet and fails on an incomplete template", async () => {
  const html = await renderPrivacyPage(template, "/privacy.css");
  expect(html).toContain('href="/privacy.css"');
  await expect(renderPrivacyPage("<!doctype html><html><body></body></html>")).rejects.toThrow("content root");
});
