import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bins } from "../../src/db/schema";
import { BinStorage } from "../../src/server/storage";

const stores: BinStorage[] = [];
const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "smallbin-storage-"));
  directories.push(path);
  return path;
}
async function setup(options: Partial<Parameters<typeof BinStorage.open>[0]> = {}) {
  const dataDir = options.dataDir ?? await directory();
  const storage = await BinStorage.open({ dataDir, maxStorageBytes: 1000, now: () => 1000, ...options });
  stores.push(storage);
  return { storage, dataDir };
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map(storage => storage.close()));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

test("generated migrations apply exactly once and preserve existing data", async () => {
  const { storage, dataDir } = await setup();
  const upload = await storage.beginUpload(100);
  await upload.write(new Uint8Array(100));
  const record = await upload.commit(300);
  expect(storage.database.query("SELECT COUNT(*) as count FROM __drizzle_migrations").get()).toEqual({ count: 1 });
  await storage.close();
  const { storage: restarted } = await setup({ dataDir });
  expect(restarted.database.query("SELECT COUNT(*) as count FROM __drizzle_migrations").get()).toEqual({ count: 1 });
  expect(restarted.db.select().from(bins).all()).toEqual([record]);
});

test("missing and broken migrations fail startup and release the instance lock", async () => {
  const dataDir = await directory();
  await expect(BinStorage.open({ dataDir, maxStorageBytes: 1000, now: Date.now, migrationsFolder: join(dataDir, "missing") })).rejects.toThrow();
  const broken = join(dataDir, "bad-migrations");
  await mkdir(join(broken, "meta"), { recursive: true });
  await Bun.write(join(broken, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "sqlite", entries: [{ idx: 0, version: "6", when: 1789950000000, tag: "0000_broken", breakpoints: true }] }));
  await Bun.write(join(broken, "0000_broken.sql"), "THIS IS NOT SQL;");
  await expect(BinStorage.open({ dataDir, maxStorageBytes: 1000, now: Date.now, migrationsFolder: broken })).rejects.toThrow();
  const { storage } = await setup({ dataDir });
  expect(storage.db.select().from(bins).all()).toEqual([]);
});

test("a second application cannot open the same persistent directory", async () => {
  const { storage, dataDir } = await setup();
  await expect(BinStorage.open({ dataDir, maxStorageBytes: 1000, now: Date.now })).rejects.toThrow();
  await storage.close();
  const { storage: restarted } = await setup({ dataDir });
  expect(restarted.db.select().from(bins).all()).toEqual([]);
});

test("interrupted-upload and rename-before-commit debris is reconciled on restart", async () => {
  const { storage, dataDir } = await setup();
  await storage.close();
  await Bun.write(join(dataDir, "tmp", "aborted.part"), "uncommitted ciphertext");
  await Bun.write(join(dataDir, "blobs", "AAAAAAAAAAAAAAAAAAAAAA.bin"), "uncommitted ciphertext");
  const { storage: resumed } = await setup({ dataDir });
  expect(await readdir(join(dataDir, "tmp"))).toEqual([]);
  expect(await readdir(join(dataDir, "blobs"))).toEqual([]);
  expect(resumed.db.select().from(bins).all()).toEqual([]);
});

test("startup reconciles missing, corrupt-length and expired blobs", async () => {
  const { storage, dataDir } = await setup();
  const created = [];
  for (let i = 0; i < 3; i++) {
    const upload = await storage.beginUpload(100);
    await upload.write(new Uint8Array(100));
    created.push(await upload.commit(i === 2 ? 1 : 300));
  }
  await storage.close();
  await rm(join(dataDir, "blobs", `${created[0]!.id}.bin`));
  await Bun.write(join(dataDir, "blobs", `${created[1]!.id}.bin`), "truncated");
  const { storage: restarted } = await setup({ dataDir, now: () => 2000 });
  expect(restarted.db.select().from(bins).all()).toEqual([]);
  expect(await readdir(join(dataDir, "blobs"))).toEqual([]);
});

test("database failure after blob rename compensates the file and reservation", async () => {
  const { storage, dataDir } = await setup({ maxStorageBytes: 100 });
  const upload = await storage.beginUpload(100);
  await upload.write(new Uint8Array(100));
  storage.database.exec("PRAGMA query_only = ON");
  await expect(upload.commit(300)).rejects.toThrow();
  await upload.abort();
  storage.database.exec("PRAGMA query_only = OFF");
  expect(await readdir(join(dataDir, "tmp"))).toEqual([]);
  expect(await readdir(join(dataDir, "blobs"))).toEqual([]);
  expect(storage.db.select().from(bins).all()).toEqual([]);
  const next = await storage.beginUpload(100);
  await next.write(new Uint8Array(100));
  expect((await next.commit(300)).size).toBe(100);
});

test("file-open failure releases quota and never inserts metadata", async () => {
  const { storage, dataDir } = await setup({ maxStorageBytes: 100 });
  await rm(storage.temporaryDir, { recursive: true });
  await Bun.write(storage.temporaryDir, "not a directory");
  await expect(storage.beginUpload(100)).rejects.toThrow();
  expect(storage.db.select().from(bins).all()).toEqual([]);
  await rm(storage.temporaryDir);
  await mkdir(storage.temporaryDir, { mode: 0o700 });
  const retry = await storage.beginUpload(100);
  await retry.abort();
  expect(await readdir(join(dataDir, "tmp"))).toEqual([]);
});

test("filesystem free-space admission accounts for cumulative reservations", async () => {
  const { storage } = await setup();
  const actual = await fs.statfs(storage.temporaryDir, { bigint: true });
  const space = spyOn(fs, "statfs").mockResolvedValue({ ...actual, bavail: 150n, bsize: 1n });
  try {
    const first = await storage.beginUpload(100);
    await expect(storage.beginUpload(100)).rejects.toMatchObject({ status: 507 });
    await first.abort();
    await (await storage.beginUpload(100)).abort();
  } finally { space.mockRestore(); }
});

test("failed rename never publishes metadata and can be aborted repeatedly", async () => {
  const { storage, dataDir } = await setup({ maxStorageBytes: 100 });
  const upload = await storage.beginUpload(100);
  await upload.write(new Uint8Array(100));
  await rm(storage.blobsDir, { recursive: true });
  await Bun.write(storage.blobsDir, "not a directory");
  await expect(upload.commit(300)).rejects.toThrow();
  await upload.abort(); await upload.abort();
  expect(storage.db.select().from(bins).all()).toEqual([]);
  expect(await readdir(join(dataDir, "tmp"))).toEqual([]);
  await rm(storage.blobsDir);
  await mkdir(storage.blobsDir, { mode: 0o700 });
  const retry = await storage.beginUpload(100);
  await retry.abort();
});

test("expired files with deletion failures retain quota until a later successful cleanup", async () => {
  let now = 0;
  const { storage } = await setup({ maxStorageBytes: 100, now: () => now });
  const upload = await storage.beginUpload(100);
  await upload.write(new Uint8Array(100));
  const record = await upload.commit(1);
  now = 1000;
  await chmod(storage.blobsDir, 0o500);
  try {
    await storage.maintenance();
    expect(storage.db.select().from(bins).all()).toEqual([record]);
    await expect(storage.beginUpload(100)).rejects.toMatchObject({ status: 507 });
  } finally { await chmod(storage.blobsDir, 0o700); }
  await storage.maintenance();
  expect(storage.db.select().from(bins).all()).toEqual([]);
  await (await storage.beginUpload(100)).abort();
});

test("aborted temporary files with deletion failures are charged until cleanup retries", async () => {
  const { storage } = await setup({ maxStorageBytes: 100 });
  const upload = await storage.beginUpload(100);
  await upload.write(new Uint8Array(100));
  await chmod(storage.temporaryDir, 0o500);
  try {
    await upload.abort();
    await expect(storage.beginUpload(100)).rejects.toMatchObject({ status: 507 });
  } finally { await chmod(storage.temporaryDir, 0o700); }
  await storage.maintenance();
  expect(await readdir(storage.temporaryDir)).toEqual([]);
  await (await storage.beginUpload(100)).abort();
});

test("quota survives restart, expired data frees space, write reservations bound actual bytes", async () => {
  const { storage, dataDir } = await setup({ maxStorageBytes: 100 });
  const upload = await storage.beginUpload(100);
  await upload.write(new Uint8Array(100));
  await expect(upload.write(new Uint8Array(1))).rejects.toMatchObject({ status: 413 });
  const record = await upload.commit(1);
  await expect(upload.write(new Uint8Array(1))).rejects.toThrow();
  await expect(upload.commit(1)).rejects.toThrow();
  await storage.close();
  let now = 1000;
  const { storage: resumed } = await setup({ dataDir, maxStorageBytes: 100, now: () => now });
  await expect(resumed.beginUpload(1)).rejects.toMatchObject({ status: 507 });
  now = record.expiresAt;
  await resumed.maintenance();
  await (await resumed.beginUpload(100)).abort();
  await resumed.close();
  await expect(resumed.beginUpload(100)).rejects.toMatchObject({ status: 503 });
});

test("missing and shortened files are unavailable without exposing filesystem errors", async () => {
  const { storage } = await setup();
  const upload = await storage.beginUpload(100);
  await upload.write(new Uint8Array(100));
  const record = await upload.commit(300);
  expect(await storage.acquireDownload("../smallbin.sqlite")).toBeNull();
  await Bun.write(join(storage.blobsDir, `${record.id}.bin`), "short");
  expect(await storage.acquireDownload(record.id)).toBeNull();
  await rm(join(storage.blobsDir, `${record.id}.bin`));
  expect(await storage.acquireDownload(record.id)).toBeNull();
});

test("committed SQLite only contains the intended metadata and no upload reservations", async () => {
  const { storage, dataDir } = await setup();
  const upload = await storage.beginUpload(100);
  await upload.write(new Uint8Array(100));
  const observer = new Database(join(dataDir, "smallbin.sqlite"), { readonly: true });
  expect(observer.query("SELECT count(*) as count FROM bins").get()).toEqual({ count: 0 });
  await upload.commit(300);
  expect(observer.query("SELECT count(*) as count FROM bins").get()).toEqual({ count: 1 });
  observer.close();
});
