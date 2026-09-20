import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "../..");
const fixtures: string[] = [];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "smallbin-setup-"));
  fixtures.push(root);
  for (const path of ["scripts/setup.sh", "compose.yaml", ".env.example", "deploy/nginx-http.conf.template", "deploy/nginx.conf.template"]) {
    await Bun.write(join(root, path), Bun.file(join(repository, path)));
  }
  // Any accidental infrastructure command in prepare mode fails the test.
  for (const command of ["docker", "sudo", "apt-get", "certbot", "systemctl", "nginx", "curl"]) {
    const path = join(root, "bin", command);
    await Bun.write(path, '#!/bin/sh\nprintf "%s\\n" "$0" >> "$SETUP_COMMAND_LOG"\nexit 99\n');
    await chmod(path, 0o755);
  }
  return root;
}

async function run(root: string, input = "", args = ["--prepare-only"]) {
  const child = Bun.spawn(["bash", join(root, "scripts/setup.sh"), ...args], {
    cwd: tmpdir(),
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, SETUP_COMMAND_LOG: join(root, "commands.log") },
    stdin: new Blob([input]), stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(await Bun.file(join(root, "commands.log")).exists()).toBe(false);
    return { stdout, stderr, exit };
  } finally { clearTimeout(timer); }
}

async function env(root: string) { return Bun.file(join(root, ".env")).text(); }
async function values(root: string) {
  return Object.fromEntries((await env(root)).split("\n").filter(line => /^[A-Z_]+=/.test(line)).map(line => {
    const separator = line.indexOf("=");
    return [line.slice(0, separator), line.slice(separator + 1).replace(/^'|'$/g, "")];
  }));
}

afterEach(async () => { await Promise.all(fixtures.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("interactive deployment setup", () => {
  test("script parses as Bash", async () => {
    const child = Bun.spawn(["bash", "-n", join(repository, "scripts/setup.sh")], { stdout: "pipe", stderr: "pipe" });
    const stderr = await new Response(child.stderr).text();
    expect(stderr).toBe("");
    expect(await child.exited).toBe(0);
  });

  test("help and invalid options do not create configuration", async () => {
    const root = await fixture();
    const help = await run(root, "", ["--help"]);
    expect(help.exit).toBe(0);
    expect(help.stdout).toContain("--prepare-only");
    expect((await run(root, "", ["--unknown"])).exit).not.toBe(0);
    expect(await Bun.file(join(root, ".env")).exists()).toBe(false);
  });

  test("generates private config and both nginx templates with defaults without changing host", async () => {
    const root = await fixture();
    const result = await run(root, "bin.example.test\n\n\ny\n");
    expect(result.exit).toBe(0);
    expect(await values(root)).toMatchObject({ PUBLIC_ORIGIN: "https://bin.example.test", PORT: "3210", MAX_STORAGE_BYTES: "10000000000", TRUSTED_PROXIES: "" });
    expect((await stat(join(root, ".env"))).mode & 0o777).toBe(0o600);
    const https = await Bun.file(join(root, "deploy/generated/nginx-https.conf")).text();
    const http = await Bun.file(join(root, "deploy/generated/nginx-http.conf")).text();
    expect(https).toContain("server_name bin.example.test;");
    expect(https).toContain("/etc/letsencrypt/live/bin.example.test/fullchain.pem;");
    expect(https).toContain("proxy_pass http://127.0.0.1:3210;");
    expect(https).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
    expect(https).toContain("Content-Security-Policy $smallbin_csp always;");
    expect(https).toContain("return 308 https://bin.example.test$request_uri;");
    expect(http).toContain("server_name bin.example.test;");
    expect(http).toContain("return 404;");
    for (const path of ["deploy/nginx.conf.template", "deploy/nginx-http.conf.template"]) {
      expect(await Bun.file(join(root, path)).text()).toBe(await Bun.file(join(repository, path)).text());
    }
  });

  test("rejects unsafe domains, invalid ports and quotas before accepting corrected values", async () => {
    const root = await fixture();
    const marker = join(root, "injected");
    const result = await run(root, `https://bad.test\nevil.test;touch ${marker}\nvalid.example.test\n1023\n65536\n4321\n0\n1.2.3\n2\ny\n`);
    expect(result.exit).toBe(0);
    expect(await values(root)).toMatchObject({ PUBLIC_ORIGIN: "https://valid.example.test", PORT: "4321", MAX_STORAGE_BYTES: "2000000000" });
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await Bun.file(join(root, "deploy/generated/nginx-https.conf")).text()).toContain("proxy_pass http://127.0.0.1:4321;");
  });

  test("declining or ending input before confirmation leaves no configuration", async () => {
    const root = await fixture();
    await run(root, "bin.example.test\n\n\nn\n");
    expect(await Bun.file(join(root, ".env")).exists()).toBe(false);
    expect((await run(root, "bin.example.test\n")).exit).not.toBe(0);
    expect(await Bun.file(join(root, ".env")).exists()).toBe(false);
    expect(await Bun.file(join(root, "deploy/generated/nginx-https.conf")).exists()).toBe(false);
  });

  test("preserves safe existing values without executing env contents and backs up replacement", async () => {
    const root = await fixture();
    const marker = join(root, "injected");
    const previous = `PUBLIC_ORIGIN='https://old.example.test'\nPORT="4321"\nMAX_STORAGE_BYTES=20000000000\nUPLOAD_TIMEOUT_MS=180000\nDOWNLOAD_TIMEOUT_MS=240000\nTRUSTED_PROXIES=172.18.0.1\nSMALLBIN_IMAGE=smallbin:Release-1\nUNRELATED=$(touch ${marker})\n`;
    await Bun.write(join(root, ".env"), previous);
    const result = await run(root, "\n\n\ny\ny\n");
    expect(result.exit).toBe(0);
    expect(await values(root)).toMatchObject({ PUBLIC_ORIGIN: "https://old.example.test", PORT: "4321", MAX_STORAGE_BYTES: "20000000000", UPLOAD_TIMEOUT_MS: "180000", DOWNLOAD_TIMEOUT_MS: "240000", SMALLBIN_IMAGE: "smallbin:Release-1" });
    expect(await Bun.file(marker).exists()).toBe(false);
    const backups = (await readdir(root)).filter(path => path.startsWith(".env.") && path !== ".env.example");
    expect(backups.length).toBeGreaterThan(0);
    expect(await Bun.file(join(root, backups[0]!)).text()).toBe(previous);
    expect((await stat(join(root, backups[0]!))).mode & 0o077).toBe(0);
  });

  test("declining replacement preserves existing env and rendered config", async () => {
    const root = await fixture();
    expect((await run(root, "bin.example.test\n\n\ny\n")).exit).toBe(0);
    const previous = await env(root);
    const nginx = await Bun.file(join(root, "deploy/generated/nginx-https.conf")).text();
    await run(root, "new.example.test\n4321\n5\ny\nn\n");
    expect(await env(root)).toBe(previous);
    expect(await Bun.file(join(root, "deploy/generated/nginx-https.conf")).text()).toBe(nginx);
  });
});

async function functionHarness(root: string, body: string, environment: Record<string, string> = {}) {
  const script = join(root, "harness.sh");
  await Bun.write(script, 'set -Eeuo pipefail\nsource "$SETUP_SCRIPT"\ninitialize_paths\n' + body);
  const child = Bun.spawn(["bash", script], {
    cwd: root, env: { ...process.env, SETUP_SCRIPT: join(root, "scripts/setup.sh"), ...environment },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, exit };
}

describe("setup host-operation failure handling", () => {
  for (const stage of ["validation", "reload", "success"]) {
    test(`nginx installation preserves the previous site on ${stage}`, async () => {
      const root = await fixture();
      const previous = "previous working nginx configuration\n";
      await Bun.write(join(root, "site.conf"), previous);
      await Bun.write(join(root, "new.conf"), "replacement configuration\n");
      const result = await functionHarness(root, `
run_root() {
  case "$1" in
    nginx) [[ "$TEST_STAGE" != validation ]] ;;
    systemctl) [[ "$TEST_STAGE" != reload ]] ;;
    *) "$@" ;;
  esac
}
install_nginx_config "$REPO_DIR/new.conf" "$REPO_DIR/site.conf"
`, { TEST_STAGE: stage });
      expect(result.exit === 0).toBe(stage === "success");
      expect(await Bun.file(join(root, "site.conf")).text()).toBe(stage === "success" ? "replacement configuration\n" : previous);
      const backups = (await readdir(root)).filter(name => name.startsWith("site.conf.bak."));
      expect(backups.length).toBe(1);
      expect(await Bun.file(join(root, backups[0]!)).text()).toBe(previous);
    });
  }

  test("invalid initial nginx config is removed without reloading a service", async () => {
    const root = await fixture();
    await Bun.write(join(root, "new.conf"), "invalid nginx config\n");
    const result = await functionHarness(root, `
run_root() {
  case "$1" in
    nginx) return 1 ;;
    systemctl) touch "$REPO_DIR/unexpected-reload"; return 1 ;;
    *) "$@" ;;
  esac
}
install_nginx_config "$REPO_DIR/new.conf" "$REPO_DIR/site.conf"
`);
    expect(result.exit).not.toBe(0);
    expect(await Bun.file(join(root, "site.conf")).exists()).toBe(false);
    expect(await Bun.file(join(root, "unexpected-reload")).exists()).toBe(false);
  });

  test("discovers only the exact IPv4 gateway of the Smallbin bridge", async () => {
    const root = await fixture();
    const result = await functionHarness(root, `
run_docker() {
  case "$*" in
    'network ls '*) printf '%s\\n' 'abc123def456' ;;
    *'{{.Driver}}') printf '%s\\n' bridge ;;
    *'{{range .IPAM.Config}}{{println .Gateway}}{{end}}') printf '%s\\n' '172.19.0.1' 'fd00::1' ;;
    *) return 99 ;;
  esac
}
write_env() { printf 'TRUSTED=%s\\n' "$TRUSTED_PROXIES"; }
configure_proxy_trust
`);
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("TRUSTED=172.19.0.1");
    expect(result.stdout).not.toContain("TRUSTED=fd00");
  });

  test("ambiguous bridge gateways fail without changing the trusted peer", async () => {
    const root = await fixture();
    const result = await functionHarness(root, `
run_docker() {
  case "$*" in
    'network ls '*) printf '%s\\n' 'abc123def456' ;;
    *'{{.Driver}}') printf '%s\\n' bridge ;;
    *'{{range .IPAM.Config}}{{println .Gateway}}{{end}}') printf '%s\\n' '172.19.0.1' '172.20.0.1' ;;
    *) return 99 ;;
  esac
}
write_env() { touch "$REPO_DIR/unexpected-write"; }
configure_proxy_trust
`);
    expect(result.exit).not.toBe(0);
    expect(await Bun.file(join(root, "unexpected-write")).exists()).toBe(false);
  });
});

test("Compose uses explicit project/config and ignores conflicting shell configuration", async () => {
  const root = await fixture();
  const docker = join(root, "bin/docker");
  await Bun.write(docker, `#!/bin/sh
printf 'PUBLIC_ORIGIN=%s\\nPORT=%s\\nTRUSTED_PROXIES=%s\\n' "\${PUBLIC_ORIGIN-unset}" "\${PORT-unset}" "\${TRUSTED_PROXIES-unset}"
printf '%s\\n' "$@"
`);
  await chmod(docker, 0o755);
  const result = await functionHarness(root, `
run_root() { "$@"; }
run_compose config --quiet
`, { PATH: `${join(root, "bin")}:${process.env.PATH}`, PUBLIC_ORIGIN: "https://unintended.test", PORT: "9999", TRUSTED_PROXIES: "0.0.0.0/0", COMPOSE_PROJECT_NAME: "unintended", COMPOSE_FILE: "/unintended.yaml" });
  expect(result.exit).toBe(0);
  expect(result.stdout).toContain("PUBLIC_ORIGIN=unset\nPORT=unset\nTRUSTED_PROXIES=unset");
  expect(result.stdout).toContain("--project-name\nsmallbin\n--env-file\n");
  expect(result.stdout).toContain(`${join(root, ".env")}\n--file\n${join(root, "compose.yaml")}\nconfig\n--quiet`);
  expect(result.stdout).not.toContain("unintended");
});

test("copy failure inside a conditional installer leaves the working site untouched", async () => {
  const root = await fixture();
  await Bun.write(join(root, "site.conf"), "working config\n");
  await Bun.write(join(root, "new.conf"), "new config\n");
  const result = await functionHarness(root, `
run_root() {
  case "$*" in
    'install -m 644 '*) return 1 ;;
    'nginx -t'|'systemctl reload nginx') touch "$REPO_DIR/unexpected-service-change"; return 0 ;;
    *) "$@" ;;
  esac
}
if ! install_nginx_config "$REPO_DIR/new.conf" "$REPO_DIR/site.conf"; then exit 42; fi
`);
  expect(result.exit).toBe(42);
  expect(await Bun.file(join(root, "site.conf")).text()).toBe("working config\n");
  expect(await Bun.file(join(root, "unexpected-service-change")).exists()).toBe(false);
});

test("certificate issuance failure restores the previous HTTPS site", async () => {
  const root = await fixture();
  await Bun.write(join(root, "site.conf"), "working HTTPS config\n");
  await Bun.write(join(root, "http.conf"), "ACME bootstrap config\n");
  const result = await functionHarness(root, `
DOMAIN=bin.example.test
NGINX_SITE="$REPO_DIR/site.conf"
HTTP_CONFIG="$REPO_DIR/http.conf"
run_root() {
  case "$*" in
    'install -d -m 755 /var/www/letsencrypt'|'systemctl '*|'nginx -t') return 0 ;;
    'test -s /etc/letsencrypt/'*) return 1 ;;
    'certbot '*) return 1 ;;
    *)
      for argument in "$@"; do
        case "$argument" in /etc/*|/var/www/*) return 99 ;; esac
      done
      "$@"
      ;;
  esac
}
configure_https
`);
  expect(result.exit).not.toBe(0);
  expect(await Bun.file(join(root, "site.conf")).text()).toBe("working HTTPS config\n");
  expect(result.stderr).toContain("Certificate issuance failed");
});
