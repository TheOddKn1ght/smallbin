import { DEFAULT_TTL_SECONDS, EXPIRY_OPTIONS, LIMITS } from "../shared/config";
import { decryptBin, encryptBin } from "../shared/crypto";

export interface PublicConfig {
  maxFileBytes: number;
  maxTextBytes: number;
  expiryOptions: readonly { seconds: number; label: string }[];
  defaultTtlSeconds: number;
}

export const defaultConfig: PublicConfig = {
  maxFileBytes: LIMITS.maxFileBytes,
  maxTextBytes: LIMITS.maxTextBytes,
  expiryOptions: EXPIRY_OPTIONS,
  defaultTtlSeconds: DEFAULT_TTL_SECONDS,
};

export interface CreatedBin { id: string; expiresAt: string }
export interface LoadedBin { payload: ArrayBuffer; expiresAt: string }
export class ClientError extends Error {}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function responseMessage(status: number): string {
  if (status === 404 || status === 410) return "This bin is unavailable. It may have expired, or the link may be incorrect.";
  if (status === 413) return "This bin is too large. Use a smaller file or less text.";
  if (status === 429) return "Too many requests. Please wait a little before trying again.";
  if (status === 503 || status === 507) return "Smallbin is at capacity. Please try again later.";
  return "We couldn’t complete that request. Please try again.";
}

export async function loadConfig(signal?: AbortSignal): Promise<PublicConfig> {
  const response = await fetch("/api/config", { signal, cache: "no-store", credentials: "omit", redirect: "error" });
  if (!response.ok) throw new ClientError(responseMessage(response.status));
  const config = await response.json();
  if (config.maxFileBytes !== LIMITS.maxFileBytes || config.maxTextBytes !== LIMITS.maxTextBytes ||
    !Array.isArray(config.expiryOptions) || config.expiryOptions.length !== EXPIRY_OPTIONS.length ||
    !config.expiryOptions.every((option: { seconds?: unknown; label?: unknown }, index: number) =>
      option.seconds === EXPIRY_OPTIONS[index]?.seconds && typeof option.label === "string") ||
    config.defaultTtlSeconds !== DEFAULT_TTL_SECONDS) {
    throw new ClientError("The server configuration is incompatible. Please refresh the page.");
  }
  return config;
}

export function uploadBin(
  payload: Uint8Array,
  ttlSeconds: number,
  signal: AbortSignal,
  onProgress: (progress: number) => void,
): Promise<CreatedBin> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Upload cancelled", "AbortError"));
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = () => signal.removeEventListener("abort", abort);
    xhr.open("POST", `/api/bins?ttlSeconds=${ttlSeconds}`);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.timeout = 300_000;
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    };
    xhr.onload = () => {
      finish();
      if (xhr.status < 200 || xhr.status >= 300) return reject(new ClientError(responseMessage(xhr.status)));
      try {
        const result: CreatedBin = JSON.parse(xhr.responseText);
        if (!/^[A-Za-z0-9_-]{16,128}$/.test(result.id) || !validDate(result.expiresAt)) throw new Error("Invalid response");
        resolve(result);
      } catch {
        reject(new ClientError("The server returned an invalid response. Please try again."));
      }
    };
    xhr.onerror = () => { finish(); reject(new ClientError("The connection was interrupted. Check your connection and try again.")); };
    xhr.ontimeout = () => { finish(); reject(new ClientError("The upload timed out. Please try again.")); };
    xhr.onabort = () => { finish(); reject(new DOMException("Upload cancelled", "AbortError")); };
    signal.addEventListener("abort", abort, { once: true });
    try { xhr.send(new Blob([payload as Uint8Array<ArrayBuffer>])); }
    catch (error) { finish(); reject(error); }
  });
}

export async function retrieveBin(id: string, signal: AbortSignal): Promise<LoadedBin> {
  const response = await fetch(`/api/bins/${encodeURIComponent(id)}`, {
    signal, cache: "no-store", credentials: "omit", redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ClientError(responseMessage(response.status));
  }
  const expiresAt = response.headers.get("X-Bin-Expires-At");
  if (!validDate(expiresAt) || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new ClientError("This bin could not be read.");
  }
  const contentLength = Number(response.headers.get("Content-Length"));
  if (contentLength > LIMITS.maxEnvelopeBytes) {
    await response.body.cancel().catch(() => {});
    throw new ClientError("This bin is too large to open.");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > LIMITS.maxEnvelopeBytes) throw new ClientError("This bin is too large to open.");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
  const payload = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { payload.set(chunk, offset); offset += chunk.byteLength; }
  return { payload: payload.buffer, expiresAt };
}

export interface ClientServices {
  encrypt: typeof encryptBin;
  decrypt: typeof decryptBin;
  upload: typeof uploadBin;
  retrieve: typeof retrieveBin;
  config: typeof loadConfig;
}

export const clientServices: ClientServices = {
  encrypt: encryptBin, decrypt: decryptBin, upload: uploadBin, retrieve: retrieveBin, config: loadConfig,
};

export function formatBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${(bytes / 1_000).toFixed(bytes < 10_000 ? 1 : 0)} KB`;
  return `${(bytes / 1_000_000).toFixed(bytes < 10_000_000 ? 1 : 0)} MB`;
}

export function safeFilename(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069/\\:*?"<>|]/g, "_").replace(/^\.+|[. ]+$/g, "").slice(0, 200) || "attachment";
}

export function downloadFile(file: { name: string; bytes: Uint8Array }): () => void {
  const url = URL.createObjectURL(new Blob([file.bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = safeFilename(file.name);
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  const timeout = setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return () => { clearTimeout(timeout); URL.revokeObjectURL(url); };
}
