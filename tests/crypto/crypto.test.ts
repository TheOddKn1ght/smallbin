import { describe, expect, test } from "bun:test";
import { decodeKey, decryptBin, encryptBin, validateContent } from "../../src/shared/crypto";
import { DEFAULT_TTL_SECONDS, EXPIRY_OPTIONS, LIMITS } from "../../src/shared/config";

async function forged(clear: Uint8Array<ArrayBuffer>) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const header = new Uint8Array([83, 66, 73, 78, 1]);
  const imported = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: header, tagLength: 128 }, imported, clear));
  const payload = new Uint8Array(17 + ciphertext.length);
  payload.set(header); payload.set(iv, 5); payload.set(ciphertext, 17);
  return { payload, key: Buffer.from(key).toString("base64url") };
}
function plain(meta: unknown, contents = new Uint8Array(0)) {
  const json = new TextEncoder().encode(JSON.stringify(meta));
  const result = new Uint8Array(4 + json.length + contents.length);
  new DataView(result.buffer).setUint32(0, json.length);
  result.set(json, 4); result.set(contents, 4 + json.length);
  return result;
}

describe("encrypted envelope v1", () => {
  test("Unicode text round-trips with no attachment", async () => {
    const text = "hello\nПривет 🌒 漢字\u0000";
    const sealed = await encryptBin({ text });
    expect(await decryptBin(sealed.payload, sealed.key)).toEqual({ text, file: null });
    expect(await decryptBin(sealed.payload.buffer, sealed.key)).toEqual({ text, file: null });
    expect(new TextDecoder().decode(sealed.payload)).not.toContain("Привет");
    expect(sealed.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  test("text and arbitrary binary attachment stay together", async () => {
    const file = new File([new Uint8Array([0, 255, 128, 7])], "private-名前.bin", { type: "application/octet-stream" });
    const sealed = await encryptBin({ text: "accompanying text", file });
    const result = await decryptBin(sealed.payload, sealed.key);
    expect(result.text).toBe("accompanying text");
    expect(result.file).toEqual({ name: file.name, type: file.type, bytes: new Uint8Array([0, 255, 128, 7]) });
    const raw = new TextDecoder().decode(sealed.payload);
    expect(raw).not.toContain(file.name); expect(raw).not.toContain("accompanying text");
  });
  test("an empty file is a valid attachment", async () => {
    const sealed = await encryptBin({ text: "", file: new File([], "empty") });
    expect((await decryptBin(sealed.payload, sealed.key)).file?.bytes.length).toBe(0);
  });
  test("identical input gets fresh keys, nonces and ciphertext", async () => {
    const a = await encryptBin({ text: "same" }); const b = await encryptBin({ text: "same" });
    expect(a.key).not.toBe(b.key);
    expect(a.payload.slice(5, 17)).not.toEqual(b.payload.slice(5, 17));
    expect(a.payload).not.toEqual(b.payload);
    await expect(decryptBin(a.payload, b.key)).rejects.toThrow("could not be decrypted");
  });
  test.each([0, 4, 5, 17, 40])("tampering byte %i fails closed", async offset => {
    const sealed = await encryptBin({ text: "do not alter this text" });
    sealed.payload[offset] = sealed.payload[offset]! ^ 1;
    await expect(decryptBin(sealed.payload, sealed.key)).rejects.toThrow();
  });
  test("truncation, appended bytes and unsupported versions are rejected", async () => {
    const sealed = await encryptBin({ text: "hello" });
    for (const payload of [sealed.payload.slice(0, 5), sealed.payload.slice(0, -1), new Uint8Array([...sealed.payload, 0])]) {
      await expect(decryptBin(payload, sealed.key)).rejects.toThrow();
    }
    sealed.payload[4] = 2;
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
  test("empty input and oversize plaintext are rejected before file reads", async () => {
    await expect(encryptBin({ text: "" })).rejects.toThrow("Add");
    expect(() => validateContent({ text: "a".repeat(LIMITS.maxTextBytes) })).not.toThrow();
    expect(() => validateContent({ text: "é".repeat(LIMITS.maxTextBytes / 2 + 1) })).toThrow("1 MB");
    const file = { size: LIMITS.maxFileBytes + 1, name: "large", type: "" } as File;
    await expect(encryptBin({ text: "", file })).rejects.toThrow("100 MB");
    expect(() => validateContent({ text: "", file: { ...file, size: LIMITS.maxFileBytes } as File })).not.toThrow();
  });
  test("oversize filename and MIME are rejected", () => {
    expect(() => validateContent({ text: "", file: new File([], "a".repeat(4097)) })).toThrow("metadata");
    expect(() => validateContent({ text: "", file: new File([], "a", { type: "a".repeat(256) }) })).toThrow("metadata");
  });
  test.each([
    null,
    { textLength: -1, file: null },
    { textLength: 1.2, file: null },
    { textLength: LIMITS.maxTextBytes + 1, file: null },
    { textLength: 1, file: { name: "x", type: "", size: -1 } },
    { textLength: 1, file: { name: "x", type: "", size: LIMITS.maxFileBytes + 1 } },
    { textLength: 1, file: {} },
    { textLength: 0, file: null },
    { textLength: 1, file: null },
  ])("authenticated malformed metadata never displays", async meta => {
    const sealed = await forged(plain(meta));
    await expect(decryptBin(sealed.payload, sealed.key)).rejects.toThrow();
  });
  test("authenticated invalid UTF-8 and metadata length fail", async () => {
    const badUtf = await forged(plain({ textLength: 1, file: null }, new Uint8Array([255])));
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
