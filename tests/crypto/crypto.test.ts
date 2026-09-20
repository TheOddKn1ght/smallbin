import { describe, expect, test } from "bun:test";
import { decodeKey, decryptBin, encryptBin, validateContent, validateFiles } from "../../src/shared/crypto";
import { DEFAULT_TTL_SECONDS, EXPIRY_OPTIONS, LIMITS } from "../../src/shared/config";

const encoder = new TextEncoder();
async function forged(clear: Uint8Array<ArrayBuffer>, version = 2) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = new Uint8Array([83, 66, 73, 78, version]);
  const imported = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header, tagLength: 128 }, imported, clear));
  const payload = new Uint8Array(17 + ciphertext.length);
  payload.set(header); payload.set(iv, 5); payload.set(ciphertext, 17);
  return { payload, key: Buffer.from(key).toString("base64url") };
}
function plain(meta: unknown, contents: Uint8Array<ArrayBuffer> = new Uint8Array(0)) {
  const json = encoder.encode(JSON.stringify(meta));
  const result = new Uint8Array(4 + json.length + contents.length);
  new DataView(result.buffer).setUint32(0, json.length);
  result.set(json, 4); result.set(contents, 4 + json.length);
  return result;
}
const descriptor = (size: number, name = "file", type = "") => ({ size, name, type }) as File;

describe("encrypted envelope v2", () => {
  test("Unicode text round-trips with no attachments", async () => {
    const text = "hello\nПривет 🌒 漢字\u0000";
    const sealed = await encryptBin({ text });
    expect(sealed.payload[4]).toBe(2);
    expect(await decryptBin(sealed.payload, sealed.key)).toEqual({ text, files: [] });
    expect(await decryptBin(sealed.payload.buffer, sealed.key)).toEqual({ text, files: [] });
    expect(new TextDecoder().decode(sealed.payload)).not.toContain("Привет");
    expect(sealed.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  test("text, multiple binary files, empty files and duplicate names retain order", async () => {
    const files = [
      new File([new Uint8Array([0, 255, 128, 7])], "private-名前.bin", { type: "application/octet-stream" }),
      new File([], "empty"),
      new File([new Uint8Array([1, 2, 3])], "private-名前.bin", { type: "text/plain" }),
    ];
    const sealed = await encryptBin({ text: "accompanying text", files });
    const result = await decryptBin(sealed.payload, sealed.key);
    expect(result.text).toBe("accompanying text");
    expect(result.files).toEqual([
      { name: files[0]!.name, type: files[0]!.type, bytes: new Uint8Array([0, 255, 128, 7]) },
      { name: "empty", type: "", bytes: new Uint8Array() },
      { name: files[2]!.name, type: files[2]!.type, bytes: new Uint8Array([1, 2, 3]) },
    ]);
    const raw = new TextDecoder().decode(sealed.payload);
    expect(raw).not.toContain(files[0]!.name); expect(raw).not.toContain("accompanying text");
    expect(new Uint8Array(await files[0]!.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128, 7]));
  });
  test("empty files alone are valid; an empty selection alone is not", async () => {
    const sealed = await encryptBin({ text: "", files: [new File([], "empty"), new File([], "")] });
    expect((await decryptBin(sealed.payload, sealed.key)).files.map(file => file.bytes.length)).toEqual([0, 0]);
    expect(() => validateFiles([])).not.toThrow();
    await expect(encryptBin({ text: "", files: [] })).rejects.toThrow("Add");
  });
  test("identical input gets fresh keys, nonces and ciphertext", async () => {
    const a = await encryptBin({ text: "same" }); const b = await encryptBin({ text: "same" });
    expect(a.key).not.toBe(b.key);
    expect(a.payload.slice(5, 17)).not.toEqual(b.payload.slice(5, 17));
    expect(a.payload).not.toEqual(b.payload);
    await expect(decryptBin(a.payload, b.key)).rejects.toThrow("could not be decrypted");
  });
  test.each([0, 4, 5, 17, 40])("tampering byte %i fails closed", async offset => {
    const sealed = await encryptBin({ text: "do not alter this text", files: [new File(["a"], "a"), new File(["b"], "b")] });
    sealed.payload[offset] = sealed.payload[offset]! ^ 1;
    await expect(decryptBin(sealed.payload, sealed.key)).rejects.toThrow();
  });
  test("attachment order, sizes and contents cannot be changed without authentication", async () => {
    const input = { text: "", files: [new File(["abcd"], "first"), new File(["wxyz"], "second")] };
    const sealed = await encryptBin(input);
    const metadata = { textLength: 0, files: input.files.map(file => ({ name: file.name, type: file.type, size: file.size })) };
    const original = plain(metadata, encoder.encode("abcdwxyz"));
    const modified = [
      plain({ ...metadata, files: [...metadata.files].reverse() }, encoder.encode("abcdwxyz")),
      plain({ ...metadata, files: metadata.files.map((file, index) => ({ ...file, size: index ? 5 : 3 })) }, encoder.encode("abcdwxyz")),
      plain(metadata, encoder.encode("wxyzabcd")),
    ];
    // A known plaintext delta produces the intended ciphertext tampering, but
    // the unchanged GCM tag must reject the altered metadata or attachment order.
    for (const altered of modified) {
      expect(altered.length).toBe(original.length);
      const payload = sealed.payload.slice();
      for (let index = 0; index < original.length; index++) payload[17 + index] = payload[17 + index]! ^ original[index]! ^ altered[index]!;
      await expect(decryptBin(payload, sealed.key)).rejects.toThrow("could not be decrypted");
    }
  });
  test("truncation, appended bytes, unsupported versions and downgrade attacks are rejected", async () => {
    const sealed = await encryptBin({ text: "hello" });
    for (const payload of [sealed.payload.slice(0, 5), sealed.payload.slice(0, -1), new Uint8Array([...sealed.payload, 0])]) {
      await expect(decryptBin(payload, sealed.key)).rejects.toThrow();
    }
    sealed.payload[4] = 1;
    await expect(decryptBin(sealed.payload, sealed.key)).rejects.toThrow("could not be decrypted");
    sealed.payload[4] = 3;
    await expect(decryptBin(sealed.payload, sealed.key)).rejects.toThrow("Unsupported");
  });
  test.each(["", "a", "a".repeat(44), "!".repeat(43), "A".repeat(42) + "B"])("rejects malformed keys", key => {
    expect(() => decodeKey(key)).toThrow();
  });
  test("supports subarray views without reading unrelated bytes", async () => {
    const sealed = await encryptBin({ text: "slice" });
    const backing = new Uint8Array(sealed.payload.length + 20); backing.set(sealed.payload, 10);
    expect((await decryptBin(backing.subarray(10, -10), sealed.key)).text).toBe("slice");
  });
  test("text remains separately limited to 1 MB of UTF-8 bytes", () => {
    expect(() => validateContent({ text: "a".repeat(LIMITS.maxTextBytes), files: [descriptor(LIMITS.maxFileBytes)] })).not.toThrow();
    expect(() => validateContent({ text: "é".repeat(LIMITS.maxTextBytes / 2 + 1) })).toThrow("1 MB");
    expect(() => validateContent({ text: 1 } as never)).toThrow("string");
  });
  test("100 MB is a combined file limit and excess is rejected before any file reads", async () => {
    let reads = 0;
    const first = { ...descriptor(60_000_000), arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } } as File;
    const second = { ...descriptor(40_000_001), arrayBuffer: async () => { reads++; return new ArrayBuffer(0); } } as File;
    await expect(encryptBin({ text: "", files: [first, second] })).rejects.toThrow("combined 100 MB");
    expect(reads).toBe(0);
    expect(() => validateFiles([descriptor(60_000_000), descriptor(40_000_000)])).not.toThrow();
    expect(() => validateFiles([descriptor(LIMITS.maxFileBytes + 1)])).toThrow("100 MB");
  });
  test("two attachments totaling exactly 100 MB round-trip", async () => {
    const first = new Uint8Array(40_000_000).fill(17);
    const second = new Uint8Array(60_000_000).fill(231);
    const sealed = await encryptBin({ text: "maximum collection", files: [new File([first], "a.bin"), new File([second], "b.bin")] });
    const result = await decryptBin(sealed.payload, sealed.key);
    expect(result.files.map(file => file.bytes.length)).toEqual([40_000_000, 60_000_000]);
    const digest = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    expect(result.files.map(file => digest(file.bytes))).toEqual([digest(first), digest(second)]);
    expect(sealed.payload.length).toBeLessThanOrEqual(LIMITS.maxEnvelopeBytes);
  });
  test("changed file sizes are rejected while reading", async () => {
    const changed = { ...descriptor(2), arrayBuffer: async () => new ArrayBuffer(1) } as File;
    await expect(encryptBin({ text: "", files: [changed] })).rejects.toThrow("changed");
  });
  test("invalid selections and individual file metadata fail validation", () => {
    expect(() => validateFiles(null as never)).toThrow("selection");
    for (const size of [-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => validateFiles([descriptor(size)])).toThrow();
    expect(() => validateFiles([null as never])).toThrow();
    expect(() => validateFiles([new File([], "a".repeat(4097))])).toThrow("metadata");
    expect(() => validateFiles([new File([], "a", { type: "a".repeat(256) })])).toThrow("metadata");
  });
  test("aggregate metadata includes escaping and separators; no separate file-count cap exists", async () => {
    const initial = [descriptor(0, "a".repeat(4096)), descriptor(0, "b".repeat(4096)), descriptor(0, "c".repeat(4096)), descriptor(0, "d")];
    const baseSize = encoder.encode(JSON.stringify({ textLength: LIMITS.maxTextBytes, files: initial.map(({ name, type, size }) => ({ name, type, size })) })).length;
    const lastName = "d".repeat(1 + LIMITS.maxMetadataBytes - baseSize);
    const exact = [...initial.slice(0, 3), descriptor(0, lastName)];
    expect(() => validateFiles(exact)).not.toThrow();
    expect(() => validateFiles([...exact.slice(0, 3), descriptor(0, lastName + "d")])).toThrow("metadata");
    expect(() => validateFiles(Array.from({ length: 5 }, () => descriptor(0, '"'.repeat(2000))))).toThrow("metadata");
    const files = Array.from({ length: 100 }, () => new File([], "same"));
    expect(() => validateFiles(files)).not.toThrow();
    const sealed = await encryptBin({ text: "", files });
    expect((await decryptBin(sealed.payload, sealed.key)).files).toHaveLength(100);
  });
  test.each([
    null,
    [],
    { textLength: -1, files: [] },
    { textLength: 1.2, files: [] },
    { textLength: LIMITS.maxTextBytes + 1, files: [] },
    { textLength: 1, files: null },
    { textLength: 1, files: {} },
    { textLength: 1 },
    { textLength: 1, files: [{ name: "x", type: "", size: -1 }] },
    { textLength: 1, files: [{ name: "x", type: "", size: LIMITS.maxFileBytes + 1 }] },
    { textLength: 1, files: [descriptor(60_000_000), descriptor(40_000_001)] },
    { textLength: 1, files: [{}] },
    { textLength: 1, files: [null] },
    { textLength: 0, files: [] },
    { textLength: 1, files: [] },
    { textLength: 0, files: [descriptor(1), descriptor(1)] },
  ].map(meta => ({ meta })))("authenticated malformed metadata never displays", async ({ meta }) => {
    const sealed = await forged(plain(meta));
    await expect(decryptBin(sealed.payload, sealed.key)).rejects.toThrow();
  });
  test("authenticated invalid UTF-8 and metadata length fail", async () => {
    const badUtf = await forged(plain({ textLength: 1, files: [] }, new Uint8Array([255])));
    await expect(decryptBin(badUtf.payload, badUtf.key)).rejects.toThrow();
    const badLength = new Uint8Array(20); new DataView(badLength.buffer).setUint32(0, 20000);
    const sealed = await forged(badLength);
    await expect(decryptBin(sealed.payload, sealed.key)).rejects.toThrow("metadata length");
  });
  test("expiry choices are bounded and default matches shortest", () => {
    expect(EXPIRY_OPTIONS.map(o => o.seconds)).toEqual([300, 900, 3600, 7200, 14400, 43200]);
    expect(DEFAULT_TTL_SECONDS).toBe(300);
  });
});

describe("legacy envelope v1 compatibility", () => {
  // Fixed independently encrypted v1 fixture: old {textLength,file} metadata,
  // key bytes 0..31, IV bytes 160..171, and authenticated SBIN version 1 header.
  const fixture = {
    key: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
    payload: "U0JJTgGgoaKjpKWmp6ipqqvmGHxlPul22hoRy7ZpHbS2UpZoJb6VJAXwawS8BIkbYL8TZcWNTT9Zceh8vCtWoY0+ayNqWPJuGzkqJC7IEezelpCnHFnfgcLO0YJlw6ur265yi8qqtfxaDOmtmk6wbtdRoODz/xG1jvWDQPAk1A==",
  };
  test("existing v1 link decrypts its original text and single file into a files array", async () => {
    expect(await decryptBin(Buffer.from(fixture.payload, "base64"), fixture.key)).toEqual({
      text: "Legacy note ✓",
      files: [{ name: "old.txt", type: "text/plain", bytes: new Uint8Array([0, 255, 42]) }],
    });
  });
  test("old text-only and empty-file payloads retain their meaning", async () => {
    const text = await forged(plain({ textLength: 6, file: null }, encoder.encode("legacy")), 1);
    expect(await decryptBin(text.payload, text.key)).toEqual({ text: "legacy", files: [] });
    const file = await forged(plain({ textLength: 0, file: descriptor(0, "empty") }), 1);
    expect((await decryptBin(file.payload, file.key)).files).toEqual([{ name: "empty", type: "", bytes: new Uint8Array() }]);
  });
  test("legacy malformed metadata and relabeling to v2 are rejected", async () => {
    for (const meta of [{ textLength: 0, file: null }, { textLength: 1 }, { textLength: 0, file: {} }, { textLength: 0, files: [] }]) {
      const sealed = await forged(plain(meta), 1);
      await expect(decryptBin(sealed.payload, sealed.key)).rejects.toThrow();
    }
    const changed = Uint8Array.from(Buffer.from(fixture.payload, "base64")); changed[4] = 2;
    await expect(decryptBin(changed, fixture.key)).rejects.toThrow("could not be decrypted");
  });
});
