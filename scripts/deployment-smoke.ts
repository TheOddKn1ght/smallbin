import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { smokeNginxConfig } from "../deploy/testing";
import { decryptBin, encryptBin } from "../src/shared/crypto";
import { LIMITS } from "../src/shared/config";

if (process.env.SMALLBIN_DOCKER_SMOKE !== "1") {
  console.error("Set SMALLBIN_DOCKER_SMOKE=1 to run disposable Docker/nginx checks. Existing images are required; no image will be built or pulled.");
  process.exit(1);
}

const appImage = process.env.SMALLBIN_IMAGE || "smallbin:local";
const nginxImage = process.env.SMALLBIN_NGINX_IMAGE || "nginx:1.28-alpine";
const prefix = `smallbin-smoke-${crypto.randomUUID().slice(0, 8)}`;
const appName = `${prefix}-app`;
const proxyName = `${prefix}-nginx`;
const volumeName = `${prefix}-data`;
const origin = "https://bin.example.test";
const created: { kind: "container" | "network" | "volume"; name: string }[] = [];
let temporaryDirectory: string | undefined;
const sensitiveMarkers = new Set<string>();

async function docker(args: string[], allowFailure = false): Promise<string> {
  const process = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited,
  ]);
  if (exit !== 0 && !allowFailure) throw new Error(`docker ${args[0]} failed: ${stderr.trim()}`);
  return (args[0] === "logs" ? stdout + stderr : stdout).trim();
}

async function urlFor(name: string, internalPort: number): Promise<string> {
  const binding = await docker(["port", name, `${internalPort}/tcp`]);
  assert.match(binding, /^127\.0\.0\.1:\d+$/, "Published port must remain private");
  return `http://${binding}`;
}

async function ready(url: string, path = "/healthz"): Promise<void> {
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    try {
      const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(2000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* A container may still be starting. */ }
    await Bun.sleep(250);
  }
  throw new Error(`Readiness failed for ${path}`);
}

function privacyHeaders(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.ok(response.headers.get("content-security-policy"));
  assert.equal(response.headers.get("set-cookie"), null);
}

async function createBin(url: string, text: string, file = new File(["private attachment\n"], "private-name.txt", { type: "text/plain" })) {
  const input = { text, file };
  const encrypted = await encryptBin(input);
  const response = await fetch(`${url}/api/bins?ttlSeconds=300`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/octet-stream" }, body: encrypted.payload,
  });
  assert.equal(response.status, 201);
  privacyHeaders(response);
  const result = await response.json() as { id: string; expiresAt: string };
  assert.ok(result.id && Date.parse(result.expiresAt) > Date.now());
  for (const marker of [result.id, encrypted.key, input.text.slice(0, 100), input.file.name]) sensitiveMarkers.add(marker);
  return { ...result, ...encrypted, input };
}

async function verifyBin(url: string, bin: Awaited<ReturnType<typeof createBin>>): Promise<void> {
  const response = await fetch(`${url}/api/bins/${bin.id}`);
  assert.equal(response.status, 200);
  privacyHeaders(response);
  assert.equal(response.headers.get("x-bin-expires-at"), bin.expiresAt);
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.deepEqual(bytes, bin.payload);
  const decrypted = await decryptBin(bytes, bin.key);
  assert.equal(decrypted.text, bin.input.text);
  assert.equal(decrypted.file?.name, bin.input.file.name);
  assert.equal(decrypted.file?.type, bin.input.file.type);
  assert.equal(decrypted.file?.bytes.byteLength, bin.input.file.size);
  const expectedHash = new Bun.CryptoHasher("sha256").update(await bin.input.file.arrayBuffer()).digest("hex");
  const actualHash = new Bun.CryptoHasher("sha256").update(decrypted.file!.bytes).digest("hex");
  assert.equal(actualHash, expectedHash, "Decrypted attachment SHA-256 must match the original");
}

async function maximumRoundTrip(url: string): Promise<void> {
  const bytes = new Uint8Array(LIMITS.maxFileBytes);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
  const marker = `maximum synthetic plaintext ${prefix} `;
  const text = marker + "x".repeat(LIMITS.maxTextBytes - marker.length);
  const file = new File([bytes], `${prefix}-maximum-private.bin`, { type: "application/octet-stream" });
  const bin = await createBin(url, text, file);
  await verifyBin(url, bin);
}

async function oversizedRequest(url: string): Promise<void> {
  const response = await fetch(`${url}/api/bins?ttlSeconds=300`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/octet-stream" },
    body: new Uint8Array(102 * 1024 * 1024 + 1), signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, 413);
  privacyHeaders(response);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await response.text(), /413/, "Oversize rejection must come from nginx, before the app");
}

async function spoofedForwardingIsThrottled(url: string): Promise<void> {
  // The two successful proxy creations consumed the first two attempts. Invalid
  // TTLs also count, so this regression needs no extra stored bins or large data.
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const spoofedIp = `198.51.100.${attempt + 1}`;
    sensitiveMarkers.add(spoofedIp);
    const response = await fetch(`${url}/api/bins?ttlSeconds=1`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/octet-stream",
        "X-Forwarded-For": spoofedIp, "X-Real-IP": spoofedIp, Forwarded: `for=${spoofedIp}` },
      body: new Uint8Array(37),
    });
    assert.equal(response.status, attempt < 8 ? 400 : 429, "Forwarded-IP spoofing must not reset the proxy client's attempt budget");
    privacyHeaders(response);
    if (attempt === 8) assert.ok(Number(response.headers.get("retry-after")) > 0);
    await response.body?.cancel();
  }
}

try {
  await docker(["version", "--format", "{{.Server.Version}}"]);
  for (const image of [appImage, nginxImage]) await docker(["image", "inspect", image]);
  await docker(["network", "create", prefix]);
  created.push({ kind: "network", name: prefix });
  const configuration = JSON.parse(await docker(["network", "inspect", prefix, "--format", "{{json .IPAM.Config}}"]));
  assert.ok(Array.isArray(configuration), "Docker returned invalid network configuration");
  const ipv4 = configuration.find(entry => typeof entry?.Subnet === "string" && /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(entry.Subnet));
  assert.ok(ipv4 && typeof ipv4.Gateway === "string", "Smoke suite requires an IPv4 Docker bridge");
  const subnet = ipv4.Subnet as string;
  const gateway = ipv4.Gateway as string;
  const [networkAddress, rawPrefix] = subnet.split("/");
  const prefixLength = Number(rawPrefix);
  assert.ok(Number.isInteger(prefixLength) && prefixLength >= 1 && prefixLength <= 29,
    "Smoke subnet must have enough usable addresses for its gateway and two containers");
  const addressValue = (address: string) => {
    const octets = address.split(".");
    assert.ok(octets.length === 4 && octets.every(octet => /^\d{1,3}$/.test(octet) && Number(octet) <= 255),
      "Docker returned an invalid IPv4 address");
    return octets.reduce((value, octet) => value * 256 + Number(octet), 0);
  };
  const subnetStart = addressValue(networkAddress!);
  const subnetSize = 2 ** (32 - prefixLength);
  const gatewayValue = addressValue(gateway);
  assert.ok(subnetStart % subnetSize === 0 && gatewayValue > subnetStart && gatewayValue + 2 < subnetStart + subnetSize - 1,
    "Smoke network gateway must leave two usable container addresses before its broadcast address");
  const addressText = (address: number) => [24, 16, 8, 0].map(shift => (address >>> shift) & 255).join(".");
  const proxyIp = addressText(gatewayValue + 1);
  const appIp = addressText(gatewayValue + 2);
  // Docker only permits --ip on explicitly configured subnets. First let its
  // allocator select a free subnet, then recreate that network with explicit IPAM.
  // The existing cleanup entry also covers failures during this recreation.
  await docker(["network", "rm", prefix]);
  await docker(["network", "create", "--subnet", subnet, "--gateway", gateway, prefix]);
  for (const ip of [gateway, proxyIp, appIp, "127.0.0.1"]) sensitiveMarkers.add(ip);
  await docker(["volume", "create", volumeName]);
  created.push({ kind: "volume", name: volumeName });
  created.push({ kind: "container", name: appName });
  await docker(["run", "-d", "--pull=never", "--name", appName, "--network", prefix, "--ip", appIp, "--init", "--read-only",
    "--tmpfs", "/tmp:size=67108864,mode=1777", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "-p", "127.0.0.1::3210", "-v", `${volumeName}:/data`, "-e", `PUBLIC_ORIGIN=${origin}`, "-e", `TRUSTED_PROXIES=${proxyIp}`, appImage]);
  const appUrl = await urlFor(appName, 3210);
  await ready(appUrl);
  assert.notEqual(await docker(["exec", appName, "id", "-u"]), "0", "App must run as non-root");
  assert.equal(await docker(["inspect", appName, "--format", "{{.HostConfig.ReadonlyRootfs}}"]), "true");
  const direct = await createBin(appUrl, `deployment synthetic plaintext ${prefix}`);
  await verifyBin(appUrl, direct);
  await docker(["restart", appName]);
  await ready(appUrl);
  await verifyBin(appUrl, direct);
  console.log("PASS: non-root startup, migrations, encrypted round-trip, restart persistence");

  temporaryDirectory = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const template = await Bun.file(resolve(import.meta.dir, "../deploy/nginx.conf.template")).text();
  const configPath = join(temporaryDirectory, "nginx.conf");
  await Bun.write(configPath, smokeNginxConfig(template, appName));
  const configMount = `type=bind,src=${configPath},dst=/etc/nginx/nginx.conf,readonly`;
  await docker(["run", "--rm", "--pull=never", "--network", prefix, "--mount", configMount,
    "--entrypoint", "nginx", nginxImage, "-t"]);
  created.push({ kind: "container", name: proxyName });
  await docker(["run", "-d", "--pull=never", "--name", proxyName, "--network", prefix, "--ip", proxyIp,
    "-p", "127.0.0.1::8080", "--mount", configMount, "--entrypoint", "nginx", nginxImage, "-g", "daemon off;"]);
  const proxyUrl = await urlFor(proxyName, 8080);
  await ready(proxyUrl, "/api/config");
  const proxied = await createBin(proxyUrl, `proxy synthetic plaintext ${prefix}`);
  await verifyBin(proxyUrl, proxied);
  await maximumRoundTrip(proxyUrl);
  await oversizedRequest(proxyUrl);
  await spoofedForwardingIsThrottled(proxyUrl);
  console.log("PASS: 100 MB attachment plus 1 MB text decrypts with matching SHA-256 through nginx; nginx 413 headers; forwarded-IP spoofing cannot bypass throttling");
  const hiddenHealth = await fetch(`${proxyUrl}/healthz`);
  assert.equal(hiddenHealth.status, 404);
  privacyHeaders(hiddenHealth);
  await hiddenHealth.body?.cancel();
  const missing = await fetch(`${proxyUrl}/api/bins/${"a".repeat(32)}`);
  assert.equal(missing.status, 404);
  privacyHeaders(missing);
  await missing.body?.cancel();
  await docker(["stop", appName]);
  const unavailable = await fetch(`${proxyUrl}/api/config`);
  assert.equal(unavailable.status, 502);
  privacyHeaders(unavailable);
  await unavailable.body?.cancel();
  for (const name of [appName, proxyName]) {
    const logs = await docker(["logs", name]);
    for (const marker of sensitiveMarkers) assert.ok(!logs.includes(marker), "Logs retained bin data or client/proxy IPs");
  }
  console.log("PASS: nginx syntax, proxy round-trip, public readiness hidden, privacy headers on 404/502, no request data or IPs in logs");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  for (const resource of created.reverse()) {
    const args = resource.kind === "container" ? ["rm", "-f", resource.name] : [resource.kind, "rm", resource.name];
    await docker(args, true).catch(() => undefined);
  }
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
}
