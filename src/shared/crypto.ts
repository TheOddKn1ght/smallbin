import { LIMITS, MIN_ENVELOPE_BYTES } from "./config";

// Wire v2: magic/version (5), IV (12), AES-GCM ciphertext/tag.
// Plaintext: metadata length u32 BE, UTF-8 JSON metadata, UTF-8 text,
// then every attachment's bytes in metadata order. Version 1 remains readable.
// The complete format/version header is authenticated as additional data.
const MAGIC = new Uint8Array([0x53, 0x42, 0x49, 0x4e]);
const HEADER = new Uint8Array([...MAGIC, 2]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface BinInput { text: string; files?: readonly File[] }
export interface DecryptedBin {
  text: string;
  files: Array<{ name: string; type: string; bytes: Uint8Array<ArrayBuffer> }>;
}
interface FileMetadata { name: string; type: string; size: number }
interface Metadata {
  textLength: number;
  files: FileMetadata[];
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

function validFileMetadata(file: unknown): file is FileMetadata {
  if (!file || typeof file !== "object") return false;
  const f = file as FileMetadata;
  return typeof f.name === "string" && typeof f.type === "string" &&
    encoder.encode(f.name).length <= 4096 && encoder.encode(f.type).length <= 255 &&
    Number.isSafeInteger(f.size) && f.size >= 0 && f.size <= LIMITS.maxFileBytes;
}

/** Validate an entire selection, including enough metadata room for any valid text. */
export function validateFiles(files: readonly File[]): void {
  if (!Array.isArray(files)) throw new Error("Choose a valid file selection.");
  let totalSize = 0;
  let metadataBytes = encoder.encode(JSON.stringify({ textLength: LIMITS.maxTextBytes, files: [] })).length;
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    if (!file || !Number.isSafeInteger(file.size) || file.size < 0) throw new Error("Invalid file size.");
    if (file.size > LIMITS.maxFileBytes - totalSize) throw new Error("Files exceed the combined 100 MB limit.");
    totalSize += file.size;
    if (!validFileMetadata(file)) throw new Error("File metadata is too large or invalid.");
    metadataBytes += encoder.encode(JSON.stringify({ name: file.name, type: file.type, size: file.size })).length + (index ? 1 : 0);
    if (metadataBytes > LIMITS.maxMetadataBytes) throw new Error("File metadata is too large. Remove a file or shorten its name.");
  }
}

export function validateContent(input: BinInput): void {
  if (typeof input.text !== "string") throw new Error("Text must be a string.");
  if (encoder.encode(input.text).byteLength > LIMITS.maxTextBytes) throw new Error("Text exceeds the 1 MB limit.");
  const files = input.files ?? [];
  validateFiles(files);
  if (!input.text.length && !files.length) throw new Error("Add some text or choose a file.");
}

export async function encryptBin(input: BinInput): Promise<{ payload: Uint8Array<ArrayBuffer>; key: string }> {
  validateContent(input);
  const api = cryptoApi();
  const text = encoder.encode(input.text);
  const files = [...(input.files ?? [])];
  const metadata: Metadata = { textLength: text.length, files: files.map(file => ({ name: file.name, type: file.type, size: file.size })) };
  const meta = encoder.encode(JSON.stringify(metadata));
  if (meta.length > LIMITS.maxMetadataBytes) throw new Error("File metadata is too large.");
  const plaintext = new Uint8Array(4 + meta.length + text.length + metadata.files.reduce((total, file) => total + file.size, 0));
  const rawKey = api.getRandomValues(new Uint8Array(32));
  const iv = api.getRandomValues(new Uint8Array(12));
  try {
    new DataView(plaintext.buffer).setUint32(0, meta.length, false);
    plaintext.set(meta, 4);
    plaintext.set(text, 4 + meta.length);
    let offset = 4 + meta.length + text.length;
    for (let index = 0; index < files.length; index++) {
      const bytes = new Uint8Array(await files[index]!.arrayBuffer());
      try {
        if (bytes.byteLength !== metadata.files[index]!.size) throw new Error("A file changed while being read.");
        plaintext.set(bytes, offset);
        offset += bytes.byteLength;
      } finally { bytes.fill(0); }
    }
    const key = await api.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
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

function readMetadata(value: unknown, version: number): Metadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid bin metadata.");
  const m = value as Record<string, unknown>;
  const textLength = m.textLength;
  if (typeof textLength !== "number" || !Number.isSafeInteger(textLength) || textLength < 0 || textLength > LIMITS.maxTextBytes) throw new Error("Invalid text length.");
  const candidates = version === 1 ? (m.file === null ? [] : [m.file]) : m.files;
  if (!Array.isArray(candidates)) throw new Error("Invalid file metadata.");
  const files: FileMetadata[] = [];
  let totalSize = 0;
  for (const file of candidates) {
    if (!validFileMetadata(file) || file.size > LIMITS.maxFileBytes - totalSize) throw new Error("Invalid file metadata.");
    totalSize += file.size;
    files.push({ name: file.name, type: file.type, size: file.size });
  }
  if (textLength === 0 && !files.length) throw new Error("The bin is empty.");
  return { textLength, files };
}

export async function decryptBin(payload: ArrayBuffer | Uint8Array, encodedKey: string): Promise<DecryptedBin> {
  const size = payload.byteLength;
  if (size < MIN_ENVELOPE_BYTES || size > LIMITS.maxEnvelopeBytes) throw new Error("Invalid encrypted bin size.");
  const bytes = new Uint8Array(payload instanceof ArrayBuffer ? payload : payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
  if (!MAGIC.every((byte, index) => bytes[index] === byte) || (bytes[4] !== 1 && bytes[4] !== 2)) throw new Error("Unsupported encrypted bin format.");
  const header = bytes.slice(0, 5);
  const rawKey = decodeKey(encodedKey);
  const api = cryptoApi();
  let clear: Uint8Array<ArrayBuffer>;
  try {
    const key = await api.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    clear = new Uint8Array(await api.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(5, 17), additionalData: header, tagLength: 128 }, key, bytes.slice(17)));
  } catch {
    throw new Error("This bin could not be decrypted. The key is wrong or the data is damaged.");
  } finally { rawKey.fill(0); }
  try {
    if (clear.byteLength < 4) throw new Error("Invalid bin metadata.");
    const metaLength = new DataView(clear.buffer).getUint32(0, false);
    if (!metaLength || metaLength > LIMITS.maxMetadataBytes || metaLength + 4 > clear.length) throw new Error("Invalid bin metadata length.");
    const meta = readMetadata(JSON.parse(decoder.decode(clear.subarray(4, 4 + metaLength))), bytes[4]!);
    const textStart = 4 + metaLength;
    let fileStart = textStart + meta.textLength;
    if (fileStart + meta.files.reduce((total, file) => total + file.size, 0) !== clear.length) throw new Error("Invalid bin content length.");
    return {
      text: decoder.decode(clear.subarray(textStart, fileStart)),
      files: meta.files.map(file => {
        const bytes = clear.slice(fileStart, fileStart + file.size);
        fileStart += file.size;
        return { name: file.name, type: file.type, bytes };
      }),
    };
  } finally {
    clear.fill(0);
  }
}
