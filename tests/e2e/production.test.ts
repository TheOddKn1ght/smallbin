import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decryptBin, encryptBin } from "../../src/shared/crypto";

test("built production entry point runs with --smol, migrates, serves private pages, and preserves bins on restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "smallbin-production-"));
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
  const outputs: Promise<string>[] = [];
  async function start() {
    child = Bun.spawn([process.execPath, "--smol", resolve("dist/index.js")], {
      cwd: process.cwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, PUBLIC_ORIGIN: origin },
    });
    outputs.push(new Response(child.stdout).text(), new Response(child.stderr).text());
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Production server exited with code ${child.exitCode}`);
      try {
        const response = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(100) });
        if (response.ok) { expect(await response.json()).toEqual({ status: "ok" }); return; }
      } catch { /* Wait for initialization and migration. */ }
      await Bun.sleep(25);
    }
    throw new Error("Production startup did not become ready");
  }
  async function stop() {
    if (!child) return;
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child?.kill("SIGKILL"), 5000);
    try { expect(await child.exited).toBe(0); }
    finally { clearTimeout(timeout); child = undefined; }
  }
  try {
    await start();
    const text = "production-only-synthetic-private-content";
    const encrypted = await encryptBin({ text });
    const upload = await fetch(`${origin}/api/bins?ttlSeconds=300`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/octet-stream" }, body: encrypted.payload });
    expect(upload.status).toBe(201);
    const { id } = await upload.json() as { id: string };
    for (const route of ["/", "/privacy", `/b/${id}`]) {
      const response = await fetch(`${origin}${route}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = await response.text();
      expect(html).toContain("Smallbin");
      const scripts = [...html.matchAll(/(?:src|href)="(\/(?:chunk|favicon)[^"]+)"/g)];
      expect(scripts.length).toBeGreaterThanOrEqual(route === "/privacy" ? 2 : 3);
      if (route === "/privacy") {
        expect(html).toContain("<h1>Privacy</h1>");
        expect(html).not.toMatch(/<script|<noscript|modulepreload/);
      }
      for (const match of scripts) {
        const asset = await fetch(`${origin}${match[1]}`);
        expect(asset.status).toBe(200); await asset.body?.cancel();
      }
    }
    await stop(); await start();
    const stored = await fetch(`${origin}/api/bins/${id}`);
    expect((await decryptBin(await stored.arrayBuffer(), encrypted.key)).text).toBe(text);
    await stop();
    const logs = (await Promise.all(outputs)).join("");
    for (const marker of [text, encrypted.key, id, "127.0.0.1"]) expect(logs).not.toContain(marker);
  } finally {
    await stop();
    await rm(dataDir, { recursive: true, force: true });
  }
}, 20_000);

test("development serves privacy directly with CSS and security headers, without the client runtime", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "smallbin-privacy-dev-"));
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const origin = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, "--smol", "src/dev.ts"], {
    cwd: process.cwd(), stdin: "ignore", stdout: "ignore", stderr: "pipe",
    env: { ...process.env, NODE_ENV: "development", HOST: "127.0.0.1", PORT: String(port), DATA_DIR: dataDir, PUBLIC_ORIGIN: origin },
  });
  const errors = new Response(child.stderr).text();
  try {
    let response: Response | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Development server exited: ${await errors}`);
      try { response = await fetch(`${origin}/privacy`, { signal: AbortSignal.timeout(100) }); break; }
      catch { await Bun.sleep(25); }
    }
    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(response?.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await response!.text();
    expect(html).toContain("<h1>Privacy</h1>");
    expect(html).toContain("Privacy | Smallbin");
    expect(html).not.toMatch(/<script|<noscript|modulepreload/);
    for (const path of ["/privacy.css", "/favicon.svg"]) {
      const asset = await fetch(`${origin}${path}`);
      expect(asset.status).toBe(200);
      expect((await asset.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
    const head = await fetch(`${origin}/privacy`, { method: "HEAD" });
    expect(head.status).toBe(200); expect(await head.text()).toBe("");
    const post = await fetch(`${origin}/privacy`, { method: "POST" });
    expect(post.status).toBe(405); expect(post.headers.get("allow")).toBe("GET, HEAD");
  } finally {
    child.kill("SIGTERM");
    const timeout = setTimeout(() => child.kill("SIGKILL"), 5000);
    try { await child.exited; await errors; }
    finally { clearTimeout(timeout); await rm(dataDir, { recursive: true, force: true }); }
  }
}, 20_000);
