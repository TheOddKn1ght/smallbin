import { LIMITS, MIN_ENVELOPE_BYTES } from "./config";

// Wire v1: magic/version (5), IV (12), AES-GCM ciphertext/tag.
// Plaintext: metadata length u32 BE, UTF-8 JSON metadata, UTF-8 text, file bytes.
// The immutable format/version header is authenticated as additional data.
const HEADER = new Uint8Array([0x53, 0x42, 0x49, 0x4e, 1]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface BinInput { text: string; file?: File | null }
export interface DecryptedBin {
  text: string;
  file: { name: string; type: string; bytes: Uint8Array<ArrayBuffer> } | null;
}
interface Metadata {
  textLength: number;
  file: { name: string; type: string; size: number } | null;
}

function cryptoApi(): Crypto {
  if (!globalThis.crypto?.subtle) throw new Error("Encryption requires HTTPS or localhost.");
  return globalThis.crypto;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeKey(key: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("This link has an invalid encryption key.");
  const bytes = Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/") + "="), c => c.charCodeAt(0));
  if (bytes.length !== 32 || base64url(bytes) !== key) throw new Error("This link has an invalid encryption key.");
  return bytes;
}

export function validateContent(input: BinInput): void {
  if (typeof input.text !== "string") throw new Error("Text must be a string.");
  if (encoder.encode(input.text).byteLength > LIMITS.maxTextBytes) throw new Error("Text exceeds the 1 MB limit.");
  if (input.file && input.file.size > LIMITS.maxFileBytes) throw new Error("File exceeds the 100 MB limit.");
  if (!input.text.length && !input.file) throw new Error("Add some text or choose a file.");
  if (input.file && (encoder.encode(input.file.name).length > 4096 || encoder.encode(input.file.type).length > 255)) {
    throw new Error("File metadata is too large.");
  }
}

export async function encryptBin(input: BinInput): Promise<{ payload: Uint8Array<ArrayBuffer>; key: string }> {
  validateContent(input);
  const api = cryptoApi();
  const text = encoder.encode(input.text);
  const file = input.file ?? null;
  const metadata: Metadata = { textLength: text.length, file: file ? { name: file.name, type: file.type, size: file.size } : null };
  const meta = encoder.encode(JSON.stringify(metadata));
  if (meta.length > LIMITS.maxMetadataBytes) throw new Error("File metadata is too large.");
  const plaintext = new Uint8Array(4 + meta.length + text.length + (file?.size ?? 0));
  new DataView(plaintext.buffer).setUint32(0, meta.length, false);
  plaintext.set(meta, 4);
  plaintext.set(text, 4 + meta.length);
  if (file) {
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength !== file.size) throw new Error("The file changed while being read.");
    plaintext.set(new Uint8Array(bytes), 4 + meta.length + text.length);
  }
  const rawKey = api.getRandomValues(new Uint8Array(32));
  const iv = api.getRandomValues(new Uint8Array(12));
  const key = await api.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  try {
    const ciphertext = await api.subtle.encrypt({ name: "AES-GCM", iv, additionalData: HEADER, tagLength: 128 }, key, plaintext);
    const payload = new Uint8Array(HEADER.length + iv.length + ciphertext.byteLength);
    payload.set(HEADER);
    payload.set(iv, HEADER.length);
    payload.set(new Uint8Array(ciphertext), HEADER.length + iv.length);
    return { payload, key: base64url(rawKey) };
  } finally {
    plaintext.fill(0);
    rawKey.fill(0);
  }
}

function readMetadata(value: unknown): Metadata {
  if (!value || typeof value !== "object") throw new Error("Invalid bin metadata.");
  const m = value as Metadata;
  if (!Number.isSafeInteger(m.textLength) || m.textLength < 0 || m.textLength > LIMITS.maxTextBytes) throw new Error("Invalid text length.");
  if (m.file !== null) {
    const f = m.file;
    if (!f || typeof f !== "object" || typeof f.name !== "string" || typeof f.type !== "string" ||
      encoder.encode(f.name).length > 4096 || encoder.encode(f.type).length > 255 ||
      !Number.isSafeInteger(f.size) || f.size < 0 || f.size > LIMITS.maxFileBytes) throw new Error("Invalid file metadata.");
  }
  if (m.textLength === 0 && m.file === null) throw new Error("The bin is empty.");
  return m;
}

export async function decryptBin(payload: ArrayBuffer | Uint8Array, encodedKey: string): Promise<DecryptedBin> {
  const size = payload.byteLength;
  if (size < MIN_ENVELOPE_BYTES || size > LIMITS.maxEnvelopeBytes) throw new Error("Invalid encrypted bin size.");
  const bytes = new Uint8Array(payload instanceof ArrayBuffer ? payload : payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
  if (!HEADER.every((byte, index) => bytes[index] === byte)) throw new Error("Unsupported encrypted bin format.");
  const rawKey = decodeKey(encodedKey);
  const api = cryptoApi();
  const key = await api.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
  rawKey.fill(0);
  let clear: Uint8Array<ArrayBuffer>;
  try {
    clear = new Uint8Array(await api.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(5, 17), additionalData: HEADER, tagLength: 128 }, key, bytes.slice(17)));
  } catch {
    throw new Error("This bin could not be decrypted. The key is wrong or the data is damaged.");
  }
  try {
    if (clear.byteLength < 4) throw new Error("Invalid bin metadata.");
    const metaLength = new DataView(clear.buffer).getUint32(0, false);
    if (!metaLength || metaLength > LIMITS.maxMetadataBytes || metaLength + 4 > clear.length) throw new Error("Invalid bin metadata length.");
    const meta = readMetadata(JSON.parse(decoder.decode(clear.subarray(4, 4 + metaLength))));
    const textStart = 4 + metaLength;
    const fileStart = textStart + meta.textLength;
    if (fileStart + (meta.file?.size ?? 0) !== clear.length) throw new Error("Invalid bin content length.");
    return {
      text: decoder.decode(clear.subarray(textStart, fileStart)),
      file: meta.file ? { name: meta.file.name, type: meta.file.type, bytes: clear.slice(fileStart) } : null,
    };
  } finally {
    clear.fill(0);
  }
}
