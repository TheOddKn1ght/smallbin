import { afterEach, describe, expect, mock, test } from "bun:test";
import { ClientError, defaultConfig, formatBytes, loadConfig, responseMessage, retrieveBin, safeFilename, uploadBin } from "../../src/client/api";
import { LIMITS } from "../../src/shared/config";

const originalFetch = globalThis.fetch;
const originalXHR = globalThis.XMLHttpRequest;
const expiresAt = "2030-01-01T01:00:00.000Z";
afterEach(() => { globalThis.fetch = originalFetch; globalThis.XMLHttpRequest = originalXHR; });

class FakeXHR {
  static latest: FakeXHR;
  status = 201;
  responseText = JSON.stringify({ id: "abcdefghijklmnopqrstuv", expiresAt });
  timeout = 0;
  upload: { onprogress?: (event: { lengthComputable: boolean; loaded: number; total: number }) => void } = {};
  onload?: () => void; onerror?: () => void; ontimeout?: () => void; onabort?: () => void;
  method = ""; url = ""; body?: Blob; headers = new Map<string, string>();
  constructor() { FakeXHR.latest = this; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers.set(name, value); }
  send(body: Blob) { this.body = body; }
  abort() { this.onabort?.(); }
}
function fakeXHR() { globalThis.XMLHttpRequest = FakeXHR as unknown as typeof XMLHttpRequest; }
function respond(response: Response) { globalThis.fetch = mock(async () => response) as unknown as typeof fetch; }

describe("configuration and downloads", () => {
  test("loads server config without credentials or caching", async () => {
    respond(Response.json(defaultConfig));
    expect(await loadConfig()).toEqual(defaultConfig);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/config", expect.objectContaining({ cache: "no-store", credentials: "omit", redirect: "error" }));
  });
  test("rejects incompatible server limits and malformed configuration", async () => {
    respond(Response.json({ ...defaultConfig, maxFileBytes: 1 }));
    await expect(loadConfig()).rejects.toThrow("incompatible");
    respond(Response.json({ ...defaultConfig, expiryOptions: [] }));
    await expect(loadConfig()).rejects.toThrow("incompatible");
    respond(new Response("", { status: 503 }));
    await expect(loadConfig()).rejects.toThrow("capacity");
  });
  test("retrieves ciphertext with expiry and never puts a key in URL", async () => {
    respond(new Response(new Uint8Array([1, 2, 3]), { headers: { "X-Bin-Expires-At": expiresAt } }));
    const signal = new AbortController().signal;
    const loaded = await retrieveBin("abcdefghijklmnopqrstuv", signal);
    expect([...new Uint8Array(loaded.payload)]).toEqual([1, 2, 3]);
    expect(loaded.expiresAt).toBe(expiresAt);
    expect(globalThis.fetch).toHaveBeenCalledWith("/api/bins/abcdefghijklmnopqrstuv", { signal, cache: "no-store", credentials: "omit", redirect: "error" });
  });
  test("treats unavailable and expired bins equally", async () => {
    for (const status of [404, 410]) {
      respond(new Response("", { status }));
      await expect(retrieveBin("missing", new AbortController().signal)).rejects.toThrow("unavailable");
    }
  });
  test("rejects missing expiry metadata and large declared bodies", async () => {
    respond(new Response(new Uint8Array([1])));
    await expect(retrieveBin("bin", new AbortController().signal)).rejects.toThrow("could not be read");
    respond(new Response(new Uint8Array([1]), { headers: { "X-Bin-Expires-At": expiresAt, "Content-Length": String(LIMITS.maxEnvelopeBytes + 1) } }));
    await expect(retrieveBin("bin", new AbortController().signal)).rejects.toThrow("too large");
  });
  test("enforces actual streamed bytes and cancels an oversized response", async () => {
    const cancel = mock(() => {});
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(LIMITS.maxEnvelopeBytes + 1)); }, cancel });
    respond(new Response(body, { headers: { "X-Bin-Expires-At": expiresAt } }));
    await expect(retrieveBin("bin", new AbortController().signal)).rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("encrypted upload", () => {
  test("sends binary envelope, reports progress, validates result", async () => {
    fakeXHR(); const progress = mock(() => {});
    const promise = uploadBin(new Uint8Array([4, 5]), 300, new AbortController().signal, progress);
    const xhr = FakeXHR.latest;
    expect(xhr.method).toBe("POST"); expect(xhr.url).toBe("/api/bins?ttlSeconds=300");
    expect(xhr.headers.get("Content-Type")).toBe("application/octet-stream");
    expect([...new Uint8Array(await xhr.body!.arrayBuffer())]).toEqual([4, 5]);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 20, total: 40 });
    expect(progress).toHaveBeenCalledWith(50);
    xhr.onload?.(); expect(await promise).toEqual({ id: "abcdefghijklmnopqrstuv", expiresAt });
  });
  test("cancels before creating a request and during a request", async () => {
    fakeXHR(); const aborted = new AbortController(); aborted.abort();
    await expect(uploadBin(new Uint8Array(), 300, aborted.signal, () => {})).rejects.toHaveProperty("name", "AbortError");
    const controller = new AbortController();
    const pending = uploadBin(new Uint8Array([1]), 300, controller.signal, () => {});
    controller.abort();
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
  });
  test.each([413, 429, 503, 500])("handles status %s", async status => {
    fakeXHR(); const pending = uploadBin(new Uint8Array([1]), 300, new AbortController().signal, () => {});
    FakeXHR.latest.status = status; FakeXHR.latest.onload?.();
    await expect(pending).rejects.toThrow(responseMessage(status));
  });
  test.each(["not-json", JSON.stringify({ id: "../../evil", expiresAt }), JSON.stringify({ id: "abcdefghijklmnopqrstuv", expiresAt: "invalid" })])("rejects malformed success %s", async responseText => {
    fakeXHR(); const pending = uploadBin(new Uint8Array([1]), 300, new AbortController().signal, () => {});
    FakeXHR.latest.responseText = responseText; FakeXHR.latest.onload?.();
    await expect(pending).rejects.toThrow("invalid response");
  });
  test("reports connection errors and timeouts", async () => {
    fakeXHR(); let pending = uploadBin(new Uint8Array([1]), 300, new AbortController().signal, () => {});
    FakeXHR.latest.onerror?.(); await expect(pending).rejects.toThrow("connection");
    pending = uploadBin(new Uint8Array([1]), 300, new AbortController().signal, () => {});
    FakeXHR.latest.ontimeout?.(); await expect(pending).rejects.toThrow("timed out");
  });
});

test("safe filenames remove paths, controls, bidi characters, and empty names", () => {
  expect(safeFilename("../../secret\u202etxt.html\u0000")).toBe("_.._secret_txt.html_");
  expect(safeFilename("... ")).toBe("attachment");
  expect(safeFilename("a".repeat(300))).toHaveLength(200);
  expect(safeFilename("résumé.pdf")).toBe("résumé.pdf");
});
test("file sizes use decimal units matching documented limits", () => {
  expect(formatBytes(0)).toBe("0 B"); expect(formatBytes(1_500)).toBe("1.5 KB");
  expect(formatBytes(10_000)).toBe("10 KB"); expect(formatBytes(1_000_000)).toBe("1.0 MB");
  expect(formatBytes(100_000_000)).toBe("100 MB");
});
