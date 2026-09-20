import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication, securityHeaders, type Application, type ApplicationOptions } from "../../src/server/app";
import { encryptBin, decryptBin } from "../../src/shared/crypto";
import { EXPIRY_OPTIONS, LIMITS, PUBLIC_CONFIG } from "../../src/shared/config";

const origin = "https://smallbin.test";
const apps: Application[] = [];
const directories: string[] = [];
async function setup(options: ApplicationOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "smallbin-api-"));
  directories.push(dataDir);
  const app = await createApplication({ dataDir, publicOrigin: origin, ...options });
  apps.push(app);
  return { app, dataDir };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.shutdown()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function request(path: string, init?: RequestInit) { return new Request(origin + path, init); }
function upload(body: BodyInit = new Uint8Array(64), headers: HeadersInit = {}, ttl = "300", signal?: AbortSignal) {
  return request(`/api/bins?ttlSeconds=${ttl}`, { method: "POST", body, signal, headers: { origin, "content-type": "application/octet-stream", ...headers } });
}
async function create(app: Application, body: Uint8Array<ArrayBuffer> = new Uint8Array(100), peer = "127.0.0.1") {
  const response = await app.handle(upload(body, { "content-length": String(body.length) }), peer);
  expect(response.status).toBe(201);
  return response.json() as Promise<{ id: string; expiresAt: string }>;
}
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

describe("API and privacy", () => {
  test("config, health and every error carry privacy headers", async () => {
    const { app } = await setup();
    expect(await (await app.handle(request("/api/config"))).json()).toEqual(PUBLIC_CONFIG);
    expect(await (await app.handle(request("/healthz"))).json()).toEqual({ status: "ok" });
    for (const path of ["/healthz", "/api/config", "/api/bins/doesnotexist", "/missing"]) {
      const response = await app.handle(request(path));
      for (const [name, value] of Object.entries(securityHeaders)) expect(response.headers.get(name)).toBe(value);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    for (const [path, allowed] of [["/healthz", "GET"], ["/api/config", "GET"], ["/api/bins", "POST"], ["/api/bins/abc", "GET"]]) {
      const response = await app.handle(request(path!, { method: "DELETE" }));
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe(allowed!);
    }
  });

  test("text and binary metadata remain encrypted across API, files and SQLite; restart persists ciphertext", async () => {
    const { app, dataDir } = await setup();
    const text = "private secret π 🥷";
    const filename = "confidential-report.txt";
    const file = new File(["top secret file bytes"], filename, { type: "text/plain" });
    const second = new File(["second private attachment"], "private-second.bin", { type: "application/octet-stream" });
    const encrypted = await encryptBin({ text, files: [file, second] });
    const result = await create(app, encrypted.payload);
    expect(result.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const response = await app.handle(request(`/api/bins/${result.id}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Bin-Expires-At")).toBe(result.expiresAt);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(encrypted.payload);
    const stored = new Uint8Array(await Bun.file(join(dataDir, "blobs", `${result.id}.bin`)).arrayBuffer());
    expect(stored).toEqual(encrypted.payload);
    const decoded = await decryptBin(stored, encrypted.key);
    expect(decoded.text).toBe(text);
    expect(decoded.files.map(file => file.name)).toEqual([filename, second.name]);
    expect(new TextDecoder().decode(decoded.files[1]!.bytes)).toBe("second private attachment");
    for (const suffix of ["smallbin.sqlite", "smallbin.sqlite-wal", `blobs/${result.id}.bin`]) {
      const contents = await Bun.file(join(dataDir, suffix)).text();
      for (const secret of [text, filename, second.name, encrypted.key, "top secret file bytes", "second private attachment"]) expect(contents.includes(secret)).toBe(false);
    }
    const db = new Database(join(dataDir, "smallbin.sqlite"), { readonly: true });
    expect((db.query("PRAGMA table_info(bins)").all() as { name: string }[]).map(row => row.name)).toEqual(["id", "created_at", "expires_at", "size"]);
    expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    db.close();
    await app.shutdown();
    const resumed = await createApplication({ dataDir, publicOrigin: origin });
    apps.push(resumed);
    expect(new Uint8Array(await (await resumed.handle(request(`/api/bins/${result.id}`))).arrayBuffer())).toEqual(encrypted.payload);
    expect((await stat(dataDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dataDir, "blobs", `${result.id}.bin`))).mode & 0o777).toBe(0o600);
  });

  test("all expiry choices are supported and start at upload completion", async () => {
    let now = Date.UTC(2026, 0, 1);
    const { app } = await setup({ now: () => now });
    for (const option of EXPIRY_OPTIONS) {
      const response = await app.handle(upload(new Uint8Array(64), {}, String(option.seconds)));
      expect(response.status).toBe(201);
      expect((await response.json()).expiresAt).toBe(new Date(now + option.seconds * 1000).toISOString());
    }
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(64)); now += 15_000; controller.close(); } });
    const response = await app.handle(upload(stream));
    expect((await response.json()).expiresAt).toBe(new Date(now + 300_000).toISOString());
  });

  test("expired bins immediately match missing bins before cleanup", async () => {
    let now = 1_000_000;
    const { app, dataDir } = await setup({ now: () => now });
    const result = await create(app);
    now += 300_000;
    const expired = await app.handle(request(`/api/bins/${result.id}`));
    const missing = await app.handle(request("/api/bins/AAAAAAAAAAAAAAAAAAAAAA"));
    expect(expired.status).toBe(404);
    expect(await expired.text()).toBe(await missing.text());
    expect((await readdir(join(dataDir, "blobs"))).length).toBe(1);
    await app.maintenance();
    expect(await readdir(join(dataDir, "blobs"))).toEqual([]);
  });

  test.each(["1", "0", "-300", "300.0", "", "foo", "300&ttlSeconds=900"])("rejects unsupported or ambiguous ttl %s", async ttl => {
    const { app } = await setup();
    expect((await app.handle(upload(new Uint8Array(64), {}, ttl))).status).toBe(400);
  });

  test("rejects cross-site or missing origins and unsupported upload types", async () => {
    const { app } = await setup();
    const rejectedHeaders: HeadersInit[] = [{ origin: "https://attacker.test" }, { origin: "" }, { "sec-fetch-site": "cross-site" }];
    for (const headers of rejectedHeaders) {
      expect((await app.handle(upload(new Uint8Array(64), headers))).status).toBe(403);
    }
    expect((await app.handle(upload(new Uint8Array(64), { "content-type": "text/plain" }))).status).toBe(415);
  });

  test("validates declared size, actual streamed bytes, empty bodies and bounds", async () => {
    const { app, dataDir } = await setup({ capacities: { attemptsPerHour: 50 } });
    const cases: [BodyInit, string, number][] = [
      [new Uint8Array(64), "-1", 400], [new Uint8Array(64), "bad", 400],
      [new Uint8Array(64), String(LIMITS.maxEnvelopeBytes + 1), 413],
      [new Uint8Array(36), "36", 400], [new Uint8Array(64), "65", 400], [new Uint8Array(65), "64", 400],
    ];
    for (const [body, length, status] of cases) expect((await app.handle(upload(body, { "content-length": length }))).status).toBe(status);
    expect((await app.handle(upload(new Uint8Array(36)))).status).toBe(400);
    expect((await app.handle(request("/api/bins?ttlSeconds=300", { method: "POST", headers: { origin, "content-type": "application/octet-stream" } }))).status).toBe(400);
    let chunks = 0;
    const oversized = new ReadableStream({ pull(controller) { if (chunks++ < 102) controller.enqueue(new Uint8Array(1_000_000)); else controller.close(); } });
    expect((await app.handle(upload(oversized))).status).toBe(413);
    expect(await readdir(join(dataDir, "tmp"))).toEqual([]);
    expect(await readdir(join(dataDir, "blobs"))).toEqual([]);
  });

  test("maximum envelope is accepted using streamed writes", async () => {
    const { app } = await setup();
    let remaining = LIMITS.maxEnvelopeBytes;
    const stream = new ReadableStream({ pull(controller) { if (!remaining) { controller.close(); return; } const size = Math.min(1_000_000, remaining); remaining -= size; controller.enqueue(new Uint8Array(size)); } });
    const response = await app.handle(upload(stream, { "content-length": String(LIMITS.maxEnvelopeBytes) }));
    expect(response.status).toBe(201);
  });

  test("upload cancellation and stalled-body deadline clear files and reservations", async () => {
    const { app, dataDir } = await setup({ uploadTimeoutMs: 25, capacities: { globalUploads: 1, perIpUploads: 1 } });
    const controller = new AbortController();
    const pending = app.handle(upload(new ReadableStream({ start(source) { source.enqueue(new Uint8Array(40)); } }), {}, "300", controller.signal));
    await tick();
    controller.abort();
    expect((await pending).status).toBe(499);
    expect((await app.handle(upload(new ReadableStream({ start(source) { source.enqueue(new Uint8Array(40)); } })))).status).toBe(408);
    expect(await readdir(join(dataDir, "tmp"))).toEqual([]);
    expect((await app.handle(upload())).status).toBe(201);
  });

  test("creation rate limits count validation failures and reset with time", async () => {
    let now = 100;
    const { app } = await setup({ now: () => now, capacities: { attemptsPerHour: 2 } });
    expect((await app.handle(upload(new Uint8Array(64), {}, "1"), "127.0.0.1")).status).toBe(400);
    await create(app);
    const limited = await app.handle(upload(), "127.0.0.1");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("3600");
    now += 3_600_000;
    expect((await app.handle(upload(), "127.0.0.1")).status).toBe(201);
  });

  test("concurrent upload limits apply per peer and globally without reservation leaks", async () => {
    const { app } = await setup({ capacities: { globalUploads: 2, perIpUploads: 1 } });
    const firstAbort = new AbortController(), secondAbort = new AbortController();
    const first = app.handle(upload(new ReadableStream(), {}, "300", firstAbort.signal), "192.0.2.1");
    await tick();
    expect((await app.handle(upload(), "192.0.2.1")).status).toBe(429);
    const second = app.handle(upload(new ReadableStream(), {}, "300", secondAbort.signal), "192.0.2.2");
    await tick();
    expect((await app.handle(upload(), "192.0.2.3")).status).toBe(429);
    firstAbort.abort(); secondAbort.abort();
    await Promise.all([first, second]);
    expect((await app.handle(upload(), "192.0.2.3")).status).toBe(201);
  });

  test("quota reservations prevent parallel overcommit, including unknown length bodies", async () => {
    const { app } = await setup({ capacities: { maxStorageBytes: 128 } });
    const cancel = new AbortController();
    const first = app.handle(upload(new ReadableStream(), { "content-length": "100" }, "300", cancel.signal), "192.0.2.1");
    await tick();
    expect((await app.handle(upload(new Uint8Array(40), { "content-length": "40" }), "192.0.2.2")).status).toBe(507);
    cancel.abort(); await first;
    expect((await app.handle(upload(new Uint8Array(40)))).status).toBe(507);
    expect((await app.handle(upload(new Uint8Array(40), { "content-length": "40" }))).status).toBe(201);
  });

  test("untrusted or malformed forwarded addresses cannot bypass quotas", async () => {
    const { app } = await setup({ capacities: { attemptsPerHour: 1 }, trustedProxies: ["10.0.0.0/24"] });
    expect((await app.handle(upload(new Uint8Array(64), { "x-forwarded-for": "192.0.2.1" }), "192.0.2.9")).status).toBe(201);
    expect((await app.handle(upload(new Uint8Array(64), { "x-forwarded-for": "192.0.2.2" }), "192.0.2.9")).status).toBe(429);
    expect((await app.handle(upload(new Uint8Array(64), { "x-forwarded-for": "192.0.2.1" }), "10.0.0.1")).status).toBe(201);
    expect((await app.handle(upload(new Uint8Array(64), { "x-forwarded-for": "192.0.2.2" }), "10.0.0.1")).status).toBe(201);
    expect((await app.handle(upload(new Uint8Array(64), { "x-forwarded-for": "192.0.2.1, 192.0.2.2" }), "10.0.0.1")).status).toBe(201);
    expect((await app.handle(upload(new Uint8Array(64), { "x-forwarded-for": "garbage" }), "10.0.0.1")).status).toBe(429);
  });

  test("bounded anonymous buckets fail closed and recover after expiration", async () => {
    let now = 0;
    const { app } = await setup({ now: () => now, capacities: { maxIpBuckets: 1 } });
    await create(app, new Uint8Array(100), "192.0.2.1");
    expect((await app.handle(upload(), "192.0.2.2")).status).toBe(503);
    now += 3_600_000;
    expect((await app.handle(upload(), "192.0.2.2")).status).toBe(201);
  });

  test("downloads preserve leases through expiry, enforce caps and release on cancellation", async () => {
    let now = 0;
    const { app, dataDir } = await setup({ now: () => now, capacities: { globalDownloads: 2, perIpDownloads: 1 } });
    const bin = await create(app, new Uint8Array(200_000));
    const first = await app.handle(request(`/api/bins/${bin.id}`), "192.0.2.1");
    expect(first.status).toBe(200);
    expect((await app.handle(request(`/api/bins/${bin.id}`), "192.0.2.1")).status).toBe(429);
    const second = await app.handle(request(`/api/bins/${bin.id}`), "192.0.2.2");
    expect((await app.handle(request(`/api/bins/${bin.id}`), "192.0.2.3")).status).toBe(429);
    await second.body!.cancel();
    now += 300_000;
    await app.maintenance();
    expect((await readdir(join(dataDir, "blobs"))).length).toBe(1);
    expect((await app.handle(request(`/api/bins/${bin.id}`), "192.0.2.3")).status).toBe(404);
    expect((await first.arrayBuffer()).byteLength).toBe(200_000);
    await app.maintenance();
    expect(await readdir(join(dataDir, "blobs"))).toEqual([]);
  });

  test("download deadline releases a client that stops reading", async () => {
    const { app } = await setup({ downloadTimeoutMs: 20, capacities: { globalDownloads: 1 } });
    const bin = await create(app, new Uint8Array(200_000));
    const stalled = await app.handle(request(`/api/bins/${bin.id}`));
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(stalled.arrayBuffer()).rejects.toThrow();
    const next = await app.handle(request(`/api/bins/${bin.id}`));
    expect(next.status).toBe(200);
    await next.body!.cancel();
  });

  test("graceful shutdown cancels pending upload and releases instance lock", async () => {
    const { app, dataDir } = await setup();
    const pending = app.handle(upload(new ReadableStream()));
    await tick();
    await app.shutdown();
    expect((await pending).status).toBe(503);
    expect(app.ready).toBe(false);
    expect((await app.handle(request("/healthz"))).status).toBe(503);
    const resumed = await createApplication({ dataDir, publicOrigin: origin });
    apps.push(resumed);
    expect(resumed.ready).toBe(true);
  });

  test("a request stream error is contained and leaves no upload or quota behind", async () => {
    const { app, dataDir } = await setup({ capacities: { maxStorageBytes: 100, globalUploads: 1 } });
    let chunk = 0;
    const stream = new ReadableStream({ pull(controller) {
      if (chunk++ === 0) controller.enqueue(new Uint8Array(40));
      else controller.error(new Error("private transport error details"));
    } });
    const response = await app.handle(upload(stream, { "content-length": "100" }));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("private transport");
    expect(await readdir(join(dataDir, "tmp"))).toEqual([]);
    expect((await app.handle(upload(new Uint8Array(100), { "content-length": "100" }))).status).toBe(201);
  });

  test("database commit failure returns a generic error and allows a clean retry", async () => {
    const { app, dataDir } = await setup({ capacities: { maxStorageBytes: 100 } });
    const observer = new Database(join(dataDir, "smallbin.sqlite"));
    try {
      observer.exec("CREATE TRIGGER fail_upload BEFORE INSERT ON bins BEGIN SELECT RAISE(ABORT, 'sensitive database failure'); END;");
      const failed = await app.handle(upload(new Uint8Array(100), { "content-length": "100" }));
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain("sensitive database");
      expect(await readdir(join(dataDir, "blobs"))).toEqual([]);
      expect(observer.query("SELECT count(*) as count FROM bins").get()).toEqual({ count: 0 });
      observer.exec("DROP TRIGGER fail_upload;");
      expect((await app.handle(upload(new Uint8Array(100), { "content-length": "100" }))).status).toBe(201);
    } finally { observer.close(); }
  });

  test("a file truncated during download errors the stream and releases its slot", async () => {
    const { app, dataDir } = await setup({ capacities: { globalDownloads: 1 } });
    const bin = await create(app, new Uint8Array(200_000));
    const download = await app.handle(request(`/api/bins/${bin.id}`));
    await Bun.write(join(dataDir, "blobs", `${bin.id}.bin`), new Uint8Array(0));
    await expect(download.arrayBuffer()).rejects.toThrow("The download could not be read.");
    // The next request is unavailable because the file is damaged; it is not
    // rejected as busy because the failed stream released admission.
    expect((await app.handle(request(`/api/bins/${bin.id}`))).status).toBe(404);
  });

  test("configuration rejects invalid capacities, proxy ranges and origins before serving", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "smallbin-config-"));
    directories.push(dataDir);
    for (const options of [
      { publicOrigin: "https://smallbin.test/path" }, { publicOrigin: "ftp://smallbin.test" },
      { uploadTimeoutMs: 0 }, { downloadTimeoutMs: -1 }, { cleanupIntervalMs: NaN },
      { capacities: { maxStorageBytes: 0 } }, { trustedProxies: ["10.0.0.0/99"] },
    ]) await expect(createApplication({ dataDir, ...options })).rejects.toThrow();
    expect(await readdir(dataDir)).toEqual([]);
  });
});
