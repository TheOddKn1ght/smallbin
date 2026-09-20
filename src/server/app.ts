import { resolve } from "node:path";
import { EXPIRY_OPTIONS, LIMITS, MIN_ENVELOPE_BYTES, PUBLIC_CONFIG } from "../shared/config";
import { Admission, clientAddress, compileTrustedProxies, DEFAULT_CAPACITIES, HttpError, type CapacityLimits } from "./limits";
import { BinStorage } from "./storage";

export const securityHeaders: Record<string, string> = {
  "Cache-Control": "no-store",
  Pragma: "no-cache",
  Expires: "0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), browsing-topics=()",
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'",
};

export interface ApplicationOptions {
  dataDir?: string;
  publicOrigin?: string;
  trustedProxies?: string[];
  capacities?: Partial<CapacityLimits>;
  now?: () => number;
  uploadTimeoutMs?: number;
  downloadTimeoutMs?: number;
  cleanupIntervalMs?: number;
  migrationsFolder?: string;
}

const positiveInteger = (value: number, name: string) => {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer.`);
  return value;
};

function json(body: unknown, status = 200, extra?: HeadersInit) {
  const headers = new Headers({ ...securityHeaders, "Content-Type": "application/json; charset=utf-8" });
  new Headers(extra).forEach((value, key) => headers.set(key, value));
  return new Response(JSON.stringify(body), { status, headers });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolvePromise, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function createApplication(options: ApplicationOptions = {}) {
  const now = options.now ?? Date.now;
  const capacities = {
    ...DEFAULT_CAPACITIES,
    maxStorageBytes: Number(process.env.MAX_STORAGE_BYTES ?? DEFAULT_CAPACITIES.maxStorageBytes),
    ...options.capacities,
  };
  for (const [name, value] of Object.entries(capacities)) positiveInteger(value, name);
  const uploadTimeoutMs = positiveInteger(options.uploadTimeoutMs ?? Number(process.env.UPLOAD_TIMEOUT_MS ?? 120_000), "UPLOAD_TIMEOUT_MS");
  const downloadTimeoutMs = positiveInteger(options.downloadTimeoutMs ?? Number(process.env.DOWNLOAD_TIMEOUT_MS ?? 120_000), "DOWNLOAD_TIMEOUT_MS");
  const cleanupIntervalMs = positiveInteger(options.cleanupIntervalMs ?? 60_000, "cleanupIntervalMs");
  let publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
  if (publicOrigin) {
    const parsed = new URL(publicOrigin);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== publicOrigin || parsed.username || parsed.password) {
      throw new Error("PUBLIC_ORIGIN must be an HTTP(S) origin without a path.");
    }
    publicOrigin = parsed.origin;
  } else if (process.env.NODE_ENV === "production") throw new Error("PUBLIC_ORIGIN is required in production.");
  const trusted = compileTrustedProxies(options.trustedProxies ?? (process.env.TRUSTED_PROXIES ?? "").split(",").map(value => value.trim()).filter(Boolean));
  const admission = new Admission(capacities, now);
  const storage = await BinStorage.open({
    dataDir: options.dataDir ?? process.env.DATA_DIR ?? resolve("data"),
    maxStorageBytes: capacities.maxStorageBytes,
    now,
    migrationsFolder: options.migrationsFolder ?? process.env.MIGRATIONS_DIR,
  });
  const closing = new AbortController();
  const active = new Set<Promise<unknown>>();
  let healthy = true;
  let shutdownTask: Promise<void> | undefined;
  const track = <T>(promise: Promise<T>) => {
    active.add(promise);
    void promise.finally(() => active.delete(promise)).catch(() => {});
    return promise;
  };
  const maintenance = async () => {
    admission.sweep();
    try { await storage.maintenance(); healthy = true; }
    catch { healthy = false; }
  };
  const cleanup = setInterval(() => { if (!closing.signal.aborted) void track(maintenance()); }, cleanupIntervalMs);
  cleanup.unref();

  async function upload(request: Request, url: URL, ip: string) {
    const expectedOrigin = publicOrigin ?? url.origin;
    if (request.headers.get("origin") !== expectedOrigin || request.headers.get("sec-fetch-site") === "cross-site") {
      throw new HttpError(403, "This upload origin is not allowed.");
    }
    const release = admission.enter(ip, "upload");
    let transaction: Awaited<ReturnType<BinStorage["beginUpload"]>> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let completed = false;
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new HttpError(408, "The upload timed out.")), uploadTimeoutMs);
    timeout.unref();
    const signal = AbortSignal.any([request.signal, closing.signal, deadline.signal]);
    try {
      if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/octet-stream") {
        throw new HttpError(415, "Encrypted uploads must use application/octet-stream.");
      }
      const ttl = url.searchParams.get("ttlSeconds");
      if (url.searchParams.getAll("ttlSeconds").length !== 1 || !ttl || !/^\d+$/.test(ttl) || !EXPIRY_OPTIONS.some(option => option.seconds === Number(ttl))) {
        throw new HttpError(400, "Choose a supported expiry time.");
      }
      const length = request.headers.get("content-length");
      if (length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))) throw new HttpError(400, "Invalid upload length.");
      const declaredSize = length === null ? null : Number(length);
      if (declaredSize !== null && declaredSize > LIMITS.maxEnvelopeBytes) throw new HttpError(413, "The encrypted upload is too large.");
      if (declaredSize !== null && declaredSize < MIN_ENVELOPE_BYTES) throw new HttpError(400, "The encrypted upload is incomplete.");
      if (!request.body) throw new HttpError(400, "The encrypted upload is missing.");
      signal.throwIfAborted();
      transaction = await storage.beginUpload(declaredSize ?? LIMITS.maxEnvelopeBytes);
      reader = request.body.getReader();
      let bytes = 0;
      while (true) {
        const result = await abortable(reader.read(), signal);
        if (result.done) break;
        bytes += result.value.byteLength;
        if (bytes > LIMITS.maxEnvelopeBytes) throw new HttpError(413, "The encrypted upload is too large.");
        if (declaredSize !== null && bytes > declaredSize) throw new HttpError(400, "The upload length does not match.");
        await transaction.write(result.value);
        signal.throwIfAborted();
      }
      if (bytes < MIN_ENVELOPE_BYTES) throw new HttpError(400, "The encrypted upload is incomplete.");
      if (declaredSize !== null && bytes !== declaredSize) throw new HttpError(400, "The upload length does not match.");
      const record = await transaction.commit(Number(ttl), signal);
      completed = true;
      return json({ id: record.id, expiresAt: new Date(record.expiresAt).toISOString() }, 201);
    } catch (error) {
      if (signal.aborted && !(error instanceof HttpError)) {
        if (deadline.signal.aborted) throw deadline.signal.reason;
        throw new HttpError(closing.signal.aborted ? 503 : 499, closing.signal.aborted ? "The service is shutting down." : "The upload was cancelled.");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      if (!completed) {
        // A custom request body's cancellation promise may never settle. Cleanup
        // must still release the file and admission reservation immediately.
        if (reader) void reader.cancel().catch(() => {});
        else if (request.body && !request.body.locked) void request.body.cancel().catch(() => {});
        await transaction?.abort();
      }
      release();
    }
  }

  async function download(request: Request, id: string, ip: string) {
    const releaseAdmission = admission.enter(ip, "download");
    let lease: Awaited<ReturnType<BinStorage["acquireDownload"]>>;
    try { lease = await storage.acquireDownload(id); }
    catch (error) { releaseAdmission(); throw error; }
    if (!lease) { releaseAdmission(); throw new HttpError(404, "This bin is unavailable."); }
    const { handle, record, release } = lease;
    let resolveDone!: () => void;
    track(new Promise<void>(resolvePromise => { resolveDone = resolvePromise; }));
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), downloadTimeoutMs);
    timeout.unref();
    const signal = AbortSignal.any([request.signal, closing.signal, deadline.signal]);
    let finished = false;
    let finishTask: Promise<void> | undefined;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const finish = () => {
      if (finishTask) return finishTask;
      finished = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      finishTask = (async () => {
        try { await handle.close(); }
        finally { release(); releaseAdmission(); resolveDone(); }
      })();
      return finishTask;
    };
    const abort = () => {
      if (!finished) controller.error(new Error("The download was cancelled."));
      void finish();
    };
    let position = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        controller = streamController;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      },
      async pull(streamController) {
        if (finished) return;
        try {
          const chunk = new Uint8Array(Math.min(65_536, record.size - position));
          const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position);
          if (finished) return;
          if (bytesRead === 0 && position !== record.size) throw new Error("The stored upload is incomplete.");
          position += bytesRead;
          if (bytesRead) streamController.enqueue(chunk.subarray(0, bytesRead));
          if (position === record.size) { await finish(); streamController.close(); }
        } catch {
          const report = !finished;
          try { await finish(); }
          finally { if (report) streamController.error(new Error("The download could not be read.")); }
        }
      },
      cancel: finish,
    });
    return new Response(stream, { headers: {
      ...securityHeaders,
      "Content-Type": "application/octet-stream",
      "Content-Disposition": "attachment",
      "Content-Length": String(record.size),
      "X-Bin-Expires-At": new Date(record.expiresAt).toISOString(),
    } });
  }

  async function handle(request: Request, peerIp = "unknown"): Promise<Response> {
    try {
      if (closing.signal.aborted) throw new HttpError(503, "The service is shutting down.");
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, { Allow: "GET" });
        return json({ status: healthy ? "ok" : "unavailable" }, healthy ? 200 : 503);
      }
      if (url.pathname === "/api/config") {
        if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, { Allow: "GET" });
        return json(PUBLIC_CONFIG);
      }
      const ip = clientAddress(request, peerIp, trusted);
      if (url.pathname === "/api/bins") {
        if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, { Allow: "POST" });
        return await track(upload(request, url, ip));
      }
      const match = /^\/api\/bins\/([^/]+)$/.exec(url.pathname);
      if (match) {
        if (request.method !== "GET") return json({ error: "Method not allowed." }, 405, { Allow: "GET" });
        return await track(download(request, match[1]!, ip));
      }
      return json({ error: "Not found." }, 404);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status, error.retryAfter ? { "Retry-After": String(error.retryAfter) } : undefined);
      if (["ENOSPC", "EDQUOT"].includes((error as { code?: string })?.code ?? "")) {
        return json({ error: "Storage is full. Try again later." }, 507, { "Retry-After": "60" });
      }
      // Do not log request URLs, plaintext, content, IPs, or raw exception details.
      return json({ error: "The service could not complete this request." }, 500);
    }
  }

  return {
    handle,
    maintenance,
    get ready() { return healthy && !closing.signal.aborted; },
    shutdown() {
      if (!shutdownTask) shutdownTask = (async () => {
        clearInterval(cleanup);
        closing.abort();
        await Promise.allSettled([...active]);
        await storage.close();
      })();
      return shutdownTask;
    },
  };
}

export type Application = Awaited<ReturnType<typeof createApplication>>;
