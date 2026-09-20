import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";

export class HttpError extends Error {
  constructor(public status: number, message: string, public retryAfter?: number) {
    super(message);
  }
}

export interface CapacityLimits {
  maxStorageBytes: number;
  globalUploads: number;
  perIpUploads: number;
  attemptsPerHour: number;
  globalDownloads: number;
  perIpDownloads: number;
  maxIpBuckets: number;
}

export const DEFAULT_CAPACITIES: CapacityLimits = {
  maxStorageBytes: 10_000_000_000,
  globalUploads: 8,
  perIpUploads: 2,
  attemptsPerHour: 10,
  globalDownloads: 16,
  perIpDownloads: 4,
  maxIpBuckets: 20_000,
};

type Bucket = { attempts: number; resetAt: number; uploads: number; downloads: number };

/** Only a process-secret HMAC of the peer address is retained in these bounded buckets. */
export class Admission {
  private readonly secret = randomBytes(32);
  private readonly buckets = new Map<string, Bucket>();
  private uploads = 0;
  private downloads = 0;

  constructor(private readonly limits: CapacityLimits, private readonly now: () => number) {}

  sweep() {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now && bucket.uploads === 0 && bucket.downloads === 0) this.buckets.delete(key);
    }
  }

  enter(ip: string, kind: "upload" | "download") {
    const key = createHmac("sha256", this.secret).update(ip).digest("hex");
    this.sweep();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.limits.maxIpBuckets) throw new HttpError(503, "The service is busy. Try again later.", 60);
      bucket = { attempts: 0, resetAt: this.now() + 3_600_000, uploads: 0, downloads: 0 };
      this.buckets.set(key, bucket);
    }
    if (bucket.resetAt <= this.now()) {
      bucket.attempts = 0;
      bucket.resetAt = this.now() + 3_600_000;
    }
    if (kind === "upload") {
      if (bucket.attempts >= this.limits.attemptsPerHour) {
        throw new HttpError(429, "Too many creation attempts. Try again later.", Math.max(1, Math.ceil((bucket.resetAt - this.now()) / 1_000)));
      }
      bucket.attempts += 1;
      if (this.uploads >= this.limits.globalUploads || bucket.uploads >= this.limits.perIpUploads) {
        throw new HttpError(429, "Too many simultaneous uploads. Try again later.", 5);
      }
      this.uploads += 1;
      bucket.uploads += 1;
    } else {
      if (this.downloads >= this.limits.globalDownloads || bucket.downloads >= this.limits.perIpDownloads) {
        throw new HttpError(429, "Too many simultaneous downloads. Try again later.", 5);
      }
      this.downloads += 1;
      bucket.downloads += 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (kind === "upload") { this.uploads -= 1; bucket.uploads -= 1; }
      else { this.downloads -= 1; bucket.downloads -= 1; }
    };
  }
}

function addressValue(address: string): { bits: number; value: bigint } | null {
  let ip = address.toLowerCase();
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  if (isIP(ip) === 4) {
    return { bits: 32, value: ip.split(".").reduce((value, octet) => (value << 8n) | BigInt(octet), 0n) };
  }
  if (isIP(ip) !== 6 || ip.includes("%")) return null;
  if (ip.includes(".")) {
    const start = ip.lastIndexOf(":") + 1;
    const tail = addressValue(ip.slice(start));
    if (!tail) return null;
    ip = ip.slice(0, start) + `${(tail.value >> 16n).toString(16)}:${(tail.value & 65535n).toString(16)}`;
  }
  const [left = "", right = ""] = ip.split("::");
  const lhs = left ? left.split(":") : [];
  const rhs = right ? right.split(":") : [];
  const groups = ip.includes("::") ? [...lhs, ...Array(8 - lhs.length - rhs.length).fill("0"), ...rhs] : lhs;
  const value = groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
  if ((value >> 32n) === 0xffffn) return { bits: 32, value: value & 0xffffffffn };
  return { bits: 128, value };
}

export function compileTrustedProxies(entries: string[]) {
  const ranges = entries.map(entry => {
    const [ip = "", prefix, extra] = entry.trim().split("/");
    const parsed = addressValue(ip);
    const bits = prefix === undefined ? parsed?.bits : Number(prefix);
    if (!parsed || extra !== undefined || bits === undefined || (prefix !== undefined && !/^\d+$/.test(prefix)) || bits < 0 || bits > parsed.bits) {
      throw new Error("TRUSTED_PROXIES contains an invalid IP address or CIDR.");
    }
    return { ...parsed, shift: BigInt(parsed.bits - bits) };
  });
  return (peer: string) => {
    const parsed = addressValue(peer);
    return !!parsed && ranges.some(range => parsed.bits === range.bits && (parsed.value >> range.shift) === (range.value >> range.shift));
  };
}

export function clientAddress(request: Request, peer: string, trusted: (peer: string) => boolean) {
  // nginx must overwrite this header. Chains are deliberately rejected.
  const forwarded = request.headers.get("x-forwarded-for")?.trim();
  const chosen = trusted(peer) && forwarded && isIP(forwarded) ? forwarded : peer;
  const parsed = addressValue(chosen);
  return parsed ? `${parsed.bits}:${parsed.value}` : "unknown";
}
