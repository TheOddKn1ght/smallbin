import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { smokeNginxConfig } from "../../deploy/testing";
import { LIMITS } from "../../src/shared/config";

const root = resolve(import.meta.dir, "../..");
const read = (name: string) => Bun.file(resolve(root, name)).text();

describe("deployment privacy and persistence contracts", () => {
  test("container is non-root, reproducible, and carries its migrations", async () => {
    const dockerfile = await read("Dockerfile");
    expect(dockerfile).toContain("FROM oven/bun:1.4.2 AS runtime");
    expect(dockerfile).toMatch(/COPY package\.json bun\.lock bunfig\.toml/);
    expect(dockerfile.match(/RUN bun install --frozen-lockfile/g)).toHaveLength(2);
    const bunfig = Bun.TOML.parse(await read("bunfig.toml")) as { install: { minimumReleaseAge: number } };
    expect(bunfig.install.minimumReleaseAge).toBeGreaterThanOrEqual(14 * 24 * 60 * 60);
    expect(dockerfile).toContain("USER bun");
    expect(dockerfile).toContain("/app/drizzle ./drizzle");
    expect(dockerfile).toContain("MIGRATIONS_DIR=/app/drizzle");
    expect(dockerfile).toContain("/healthz");
    expect(dockerfile).toContain("PORT=3210");
    expect(dockerfile).toContain("EXPOSE 3210");
    expect(dockerfile).toContain("process.env.PORT ?? 3210");
    expect(dockerfile).toContain('CMD ["bun", "dist/index.js"]');
  });

  test("Compose publishes only localhost and keeps all state on a hardened writable volume", async () => {
    const compose = Bun.YAML.parse(await read("compose.yaml")) as {
      services: { smallbin: { ports: string[]; read_only: boolean; init: boolean; cap_drop: string[];
        security_opt: string[]; volumes: string[]; tmpfs: string[]; environment: Record<string, string> } };
    };
    const app = compose.services.smallbin;
    expect(app.ports.every(port => port.startsWith("127.0.0.1:"))).toBe(true);
    expect(app.ports).toEqual(["127.0.0.1:${PORT:-3210}:3210"]);
    expect(app.environment.PORT).toBe("3210");
    expect(app.read_only).toBe(true);
    expect(app.init).toBe(true);
    expect(app.cap_drop).toContain("ALL");
    expect(app.security_opt).toContain("no-new-privileges:true");
    expect(app.volumes).toEqual(["smallbin-data:/data"]);
    expect(app.environment.DATA_DIR).toBe("/data");
    expect(app.environment.TRUSTED_PROXIES).toBe("${TRUSTED_PROXIES:-}");
    expect(app.environment.PUBLIC_ORIGIN).toContain(":?");
    expect(app.tmpfs).toEqual(["/tmp:size=67108864,mode=1777"]);
  });

  test("nginx handles max envelopes without buffering, caching, request logs, or spoofable client IPs", async () => {
    const nginx = await read("deploy/nginx.conf.template");
    const cap = Number(nginx.match(/client_max_body_size (\d+)m;/)?.[1]) * 1024 * 1024;
    expect(cap).toBeGreaterThanOrEqual(LIMITS.maxEnvelopeBytes);
    for (const directive of ["proxy_http_version 1.1;", "proxy_request_buffering off;", "proxy_buffering off;",
      "proxy_cache off;", "proxy_max_temp_file_size 0;", "proxy_next_upstream off;",
      "proxy_set_header X-Forwarded-For $remote_addr;"]) expect(nginx).toContain(directive);
    expect(nginx).not.toContain("$proxy_add_x_forwarded_for");
    expect(nginx.match(/access_log off;/g)).toHaveLength(2);
    expect(nginx.match(/error_log \/dev\/null crit;/g)).toHaveLength(2);
    for (const header of ["Cache-Control", "Referrer-Policy", "X-Content-Type-Options", "Content-Security-Policy"]) {
      expect(nginx).toContain(`proxy_hide_header ${header};`);
      expect(nginx).toMatch(new RegExp(`add_header ${header} [^\\n]+ always;`));
    }
  });

  test("image context excludes local content, secrets, and SQLite sidecars", async () => {
    const ignored = (await read(".dockerignore")).split("\n");
    for (const name of [".env", ".env.*", "data", "node_modules", "*.sqlite", "*.sqlite-wal", "*.sqlite-shm", "*.log"]) {
      expect(ignored).toContain(name);
    }
  });

  test("disposable proxy uses the production template's privacy controls", async () => {
    const config = smokeNginxConfig(await read("deploy/nginx.conf.template"), "smallbin-smoke-app");
    expect(config).toContain("listen 8080;");
    expect(config).not.toMatch(/listen 443|ssl_certificate/);
    expect(config).toContain("proxy_pass http://smallbin-smoke-app:3210;");
    expect(config).toContain("proxy_request_buffering off;");
    expect(config).toContain("add_header Content-Security-Policy $smallbin_csp always;");
    expect(() => smokeNginxConfig("", "valid")).toThrow();
    expect(() => smokeNginxConfig(config, "x; evil")).toThrow();
  });
});
