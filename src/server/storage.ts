import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, open, readdir, rename, stat, statfs, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";
import { eq, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { bins, type BinRecord } from "../db/schema";
import { HttpError } from "./limits";

export const BIN_ID = /^[A-Za-z0-9_-]{22}$/;
const missing = (error: unknown) => (error as { code?: string })?.code === "ENOENT";

export interface StorageOptions {
  dataDir: string;
  maxStorageBytes: number;
  now: () => number;
  migrationsFolder?: string;
}

export class BinStorage {
  readonly database: Database;
  readonly db;
  readonly blobsDir: string;
  readonly temporaryDir: string;
  private readonly lock: Database;
  private usedBytes = 0;
  private reservedBytes = 0;
  private readonly leases = new Map<string, number>();
  private readonly debris = new Map<string, number>();
  private maintenanceTask?: Promise<void>;
  private closed = false;

  private constructor(private options: StorageOptions, lock: Database, database: Database) {
    this.lock = lock;
    this.database = database;
    this.db = drizzle(database);
    this.blobsDir = join(options.dataDir, "blobs");
    this.temporaryDir = join(options.dataDir, "tmp");
  }

  static async open(options: StorageOptions) {
    options = { ...options, dataDir: resolve(options.dataDir) };
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    await chmod(options.dataDir, 0o700);
    const lockPath = join(options.dataDir, "instance.lock.sqlite");
    const lock = new Database(lockPath, { create: true });
    let database: Database | undefined;
    try {
      // A separate SQLite transaction is an OS-managed lifetime lock. It is released
      // even after an unclean process exit, unlike a PID file in a container.
      lock.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; CREATE TABLE IF NOT EXISTS instance_lock (id INTEGER);");
      await chmod(lockPath, 0o600);
      const dbPath = join(options.dataDir, "smallbin.sqlite");
      database = new Database(dbPath, { create: true });
      database.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
      await chmod(dbPath, 0o600);
      const storage = new BinStorage(options, lock, database);
      migrate(storage.db, { migrationsFolder: options.migrationsFolder ?? resolve("drizzle") });
      await mkdir(storage.blobsDir, { recursive: true, mode: 0o700 });
      await mkdir(storage.temporaryDir, { recursive: true, mode: 0o700 });
      await chmod(storage.blobsDir, 0o700);
      await chmod(storage.temporaryDir, 0o700);
      for (const suffix of ["-wal", "-shm"]) {
        await chmod(dbPath + suffix, 0o600).catch(error => { if (!missing(error)) throw error; });
      }
      await storage.reconcile();
      return storage;
    } catch (error) {
      database?.close();
      lock.close();
      throw error;
    }
  }

  private async reconcile() {
    for (const entry of await readdir(this.temporaryDir, { withFileTypes: true })) {
      if (entry.isFile() || entry.isSymbolicLink()) await unlink(join(this.temporaryDir, entry.name));
    }
    const records = this.db.select().from(bins).all();
    const known = new Set(records.map(record => `${record.id}.bin`));
    for (const entry of await readdir(this.blobsDir, { withFileTypes: true })) {
      if ((entry.isFile() || entry.isSymbolicLink()) && !known.has(entry.name)) await unlink(join(this.blobsDir, entry.name));
    }
    for (const record of records) {
      const path = this.blobPath(record.id);
      let size: number | undefined;
      try { size = (await stat(path)).size; }
      catch (error) { if (!missing(error)) throw error; }
      if (size !== record.size || record.expiresAt <= this.options.now()) {
        await unlink(path).catch(error => { if (!missing(error)) throw error; });
        this.db.delete(bins).where(eq(bins.id, record.id)).run();
      } else this.usedBytes += record.size;
    }
  }

  private blobPath(id: string) {
    if (!BIN_ID.test(id)) throw new Error("Invalid stored bin identifier.");
    return join(this.blobsDir, `${id}.bin`);
  }

  async beginUpload(reservation: number) {
    if (this.closed) throw new HttpError(503, "The service is shutting down.");
    if (this.usedBytes + this.reservedBytes + reservation > this.options.maxStorageBytes) {
      throw new HttpError(507, "Storage is full. Try again after existing bins expire.", 60);
    }
    this.reservedBytes += reservation;
    const id = randomBytes(16).toString("base64url");
    const temporaryPath = join(this.temporaryDir, `${id}.part`);
    let path = temporaryPath;
    let handle: FileHandle;
    try {
      const filesystem = await statfs(this.options.dataDir, { bigint: true });
      // Include every concurrent reservation, not just this request. Physical
      // free space may also be consumed by unrelated files on this filesystem.
      if (filesystem.bavail * filesystem.bsize < BigInt(this.reservedBytes)) {
        throw new HttpError(507, "Storage is full. Try again later.", 60);
      }
      handle = await open(temporaryPath, "wx", 0o600);
    }
    catch (error) { this.reservedBytes -= reservation; throw error; }
    let size = 0;
    let finished = false;
    let handleClosed = false;
    const close = async () => {
      if (!handleClosed) { handleClosed = true; await handle.close(); }
    };
    const abort = async () => {
      if (finished) return;
      finished = true;
      try { await close(); }
      finally {
        try { await unlink(path); }
        catch (error) {
          if (!missing(error)) {
            this.debris.set(path, size);
            this.usedBytes += size;
          }
        }
        this.reservedBytes -= reservation;
      }
    };
    return {
      write: async (chunk: Uint8Array) => {
        if (finished) throw new Error("Upload is already closed.");
        if (size + chunk.byteLength > reservation) throw new HttpError(413, "The encrypted upload is too large.");
        let offset = 0;
        while (offset < chunk.byteLength) {
          const result = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (result.bytesWritten === 0) throw new Error("Could not write upload.");
          offset += result.bytesWritten;
          size += result.bytesWritten;
        }
      },
      commit: async (ttlSeconds: number, signal?: AbortSignal): Promise<BinRecord> => {
        if (finished) throw new Error("Upload is already closed.");
        signal?.throwIfAborted();
        await handle.sync();
        await close();
        signal?.throwIfAborted();
        const target = this.blobPath(id);
        await rename(temporaryPath, target);
        path = target;
        const directory = await open(this.blobsDir, "r");
        try { await directory.sync(); }
        finally { await directory.close(); }
        signal?.throwIfAborted();
        const createdAt = this.options.now();
        const record = { id, createdAt, expiresAt: createdAt + ttlSeconds * 1_000, size };
        this.db.insert(bins).values(record).run();
        this.usedBytes += size;
        this.reservedBytes -= reservation;
        finished = true;
        return record;
      },
      abort,
    };
  }

  async acquireDownload(id: string) {
    if (!BIN_ID.test(id)) return null;
    const record = this.db.select().from(bins).where(eq(bins.id, id)).get();
    if (!record || record.expiresAt <= this.options.now()) return null;
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const count = (this.leases.get(id) ?? 1) - 1;
      if (count === 0) this.leases.delete(id);
      else this.leases.set(id, count);
    };
    try {
      const handle = await open(this.blobPath(id), "r");
      if ((await handle.stat()).size !== record.size) { await handle.close(); release(); return null; }
      return { record, handle, release };
    } catch (error) {
      release();
      if (missing(error)) return null;
      throw error;
    }
  }

  maintenance() {
    if (this.closed) return Promise.resolve();
    if (!this.maintenanceTask) {
      this.maintenanceTask = this.cleanup().finally(() => { this.maintenanceTask = undefined; });
    }
    return this.maintenanceTask;
  }

  private async cleanup() {
    for (const [path, size] of this.debris) {
      try { await unlink(path); }
      catch (error) { if (!missing(error)) continue; }
      this.debris.delete(path);
      this.usedBytes -= size;
    }
    for (const record of this.db.select().from(bins).where(lte(bins.expiresAt, this.options.now())).all()) {
      if (this.leases.has(record.id)) continue;
      try { await unlink(this.blobPath(record.id)); }
      catch (error) { if (!missing(error)) continue; }
      this.db.delete(bins).where(eq(bins.id, record.id)).run();
      this.usedBytes -= record.size;
    }
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.maintenanceTask;
    try { this.database.close(); }
    finally { this.lock.close(); }
  }
}
