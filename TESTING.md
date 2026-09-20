# Testing Smallbin

Use Bun 1.4.2 and the committed lockfile:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run test:coverage
```

The Bun suites cover the encryption envelope, malformed/tampered input, server routes, SQLite migrations and recovery, expiry, transfer limits, quotas, throttling, and deployment configuration. Tests use isolated temporary storage. The interactive setup tests execute Bash against temporary checkouts, covering config generation, validation, cancellation, backups, and safe handling of existing environment files without changing the host. Coverage is an aid to finding gaps; it is not proof of secure cryptography or correct deployment.

## GitHub Actions

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on pushes, pull requests, and manual dispatches. Both jobs use Ubuntu 24.04, Bun 1.4.2, and frozen lockfile installation with the existing 14-day package-age policy.

- **Bun and browser tests:** typecheck, coverage suites, production build, Chromium installation with system dependencies, then browser and production-startup tests. Coverage and generated screenshots are retained as the `test-reports` artifact for seven days, including when a later step fails.
- **Docker and nginx tests:** validate Compose, build the application image, pull the test nginx image, and run the disposable deployment smoke suite, including the maximum-size transfer.

The jobs need no repository secrets and use read-only repository permissions. Actions are pinned to commit hashes. New commits cancel older runs for the same ref. CI tests the code without publishing images or deploying the service; a successful hosted run is still needed to verify the Docker checks on that runner.

## Browser tests

Install the Chromium revision matching the locked Playwright version, build the production assets, then run the browser suite:

```sh
bunx --bun playwright install chromium
bun run build
bun run test:e2e
```

On Linux hosts missing browser system libraries, use `bunx --bun playwright install --with-deps chromium` instead. The browser download requires network access. Optionally set `PLAYWRIGHT_BROWSERS_PATH` to a writable cache directory for both installation and execution:

```sh
PLAYWRIGHT_BROWSERS_PATH=/tmp/smallbin-playwright bunx --bun playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=/tmp/smallbin-playwright bun run test:e2e
```

The suite starts isolated localhost servers with temporary storage and the real production frontend. It checks encryption/decryption, clipboard and decoded QR contents, missing/wrong keys, tampering, expiry, upload cancellation/retry, keyboard interaction, narrow layouts, and files totaling 100 MB plus a separate 1 MB of text. It inspects requests, cookies, browser storage, and server files for unintended plaintext/key retention. Screenshots are saved to `test-results/smallbin-desktop.png` and `test-results/smallbin-mobile.png`; review them visually when changing the design.

## Docker and nginx smoke test

This suite is explicit and opt-in: it starts disposable containers, a network, and a volume. It never builds or pulls images automatically and never uses the production Compose volume. Docker Engine must be running. Have the application image and nginx image locally available:

```sh
PUBLIC_ORIGIN=https://bin.example.test docker compose build
docker pull nginx:1.28-alpine
SMALLBIN_DOCKER_SMOKE=1 SMALLBIN_IMAGE=smallbin:local SMALLBIN_NGINX_IMAGE=nginx:1.28-alpine bun run test:deployment
```

The script verifies migration/readiness startup, non-root runtime, encrypted upload/download, preservation across restart, nginx template syntax, and two files totaling exactly 100 MB plus 1 MB of text through nginx. It checks each decrypted file's SHA-256, filename, MIME type, size, and position. It also checks an upload above nginx's 102 MiB limit returns nginx's own `413`, privacy headers on `404`/`413`/`429`/`502`, hidden public readiness, and absence of synthetic keys, text, all attachment filenames, small attachment plaintext, bin IDs, and client/proxy IPs in container logs. Its fresh private network trusts only the disposable nginx IP; changing forged forwarding headers must not bypass the ten-attempt creation limit.

The suite sends about 100 MB of valid encrypted content and an oversized 102 MiB request, so allow memory/disk space and local transfer time. It uses the checked-in HTTPS template through a local HTTP-only adaptation for the disposable proxy; production certificate issuance and renewal still require the checks in [DEPLOYMENT.md](DEPLOYMENT.md).

All containers bind only to randomly assigned localhost ports. Resource names have a `smallbin-smoke-` prefix. Cleanup runs after success or failure; after forcibly terminating the process, inspect leftover resources with `docker ps -a --filter name=smallbin-smoke-`, `docker network ls --filter name=smallbin-smoke-`, and `docker volume ls --filter name=smallbin-smoke-` before removing only that run's resources.

`bun run test` runs the unit, integration, component, HTTP, and static deployment checks without starting Docker or Chromium. Use that package script instead of bare `bun test`, which also discovers the browser suite. The Docker/nginx script is implemented but has not been run successfully in the development environment: the Docker daemon and Compose plugin are unavailable. Its runtime checks must be reported separately from passing static contract tests.

## Requirement-to-test checklist

| Requirement | Automated evidence |
| --- | --- |
| Text-only, one or multiple files, combined content, Unicode, empty files, 100 MB total attachments and separate 1 MB text limit | `tests/crypto/crypto.test.ts`, `tests/components/smallbin.test.tsx`, `tests/server/app.test.ts`; real maximum browser transfer in `tests/e2e/browser.test.ts`. |
| Fresh AES-GCM keys/nonces; v2 multiple-file metadata and v1 read compatibility; malformed keys, corruption, lengths, and UTF-8 fail closed | `tests/crypto/crypto.test.ts`; recipient failures in `tests/components/smallbin.test.tsx` and `tests/e2e/browser.test.ts`. |
| Fragment keys, ciphertext-only API/storage, no cookies, persistent browser storage, or external requests | `tests/client/api.test.ts`, `tests/server/app.test.ts`, `tests/e2e/browser.test.ts`. |
| Six expiry choices, five-minute default, expiry begins at upload completion, unavailable response, cleanup | `tests/components/smallbin.test.tsx`, `tests/server/app.test.ts`, `tests/server/storage.test.ts`; browser expiry in `tests/e2e/browser.test.ts`. |
| Encryption/upload states, progress, cancellation, retained draft, recoverable failures | `tests/client/api.test.ts`, `tests/components/smallbin.test.tsx`, `tests/e2e/browser.test.ts`. |
| Copyable complete link, local QR generation, recipient text copy | `tests/components/smallbin.test.tsx`; clipboard and QR decoding in `tests/e2e/browser.test.ts`. |
| Literal hostile text, individual attachment downloads, preserved file order, safe filenames, no active previews | `tests/client/api.test.ts`, `tests/components/smallbin.test.tsx`, `tests/e2e/browser.test.ts`. |
| Mobile layout, keyboard access, English interface, privacy explanation | `tests/components/smallbin.test.tsx`, `tests/e2e/browser.test.ts`; manual review of generated desktop/mobile screenshots. |
| Drizzle migrations, startup failure handling, single-instance enforcement, SQLite persistence/recovery | `tests/server/storage.test.ts`, `tests/server/app.test.ts`; image startup/restart additionally covered by the unrun deployment script. |
| Streaming limits, storage reservations, file/DB failures, aborted uploads, orphan reconciliation | `tests/server/app.test.ts`, `tests/server/storage.test.ts`. |
| Per-IP/global transfer limits, ten attempts/hour, bounded buckets, HMAC identities, trusted proxies | `tests/server/limits.test.ts`, `tests/server/app.test.ts`; nginx spoof-header regression in the unrun deployment script. |
| Downloads started before expiry, cancellation/deadlines, released quotas, graceful shutdown | `tests/server/app.test.ts`, `tests/server/storage.test.ts`. |
| CSP and other privacy headers, static-file isolation, missing frontend rejection | `tests/http/static.test.ts`, `tests/server/app.test.ts`; nginx-generated errors in the unrun deployment script. |
| Non-root Docker, private ports, persistent volume, healthcheck, 14-day dependency age, nginx buffering/cache/log configuration | `tests/deployment/contracts.test.ts`; actual containers, maximum proxy transfer, 413/429/502, log checks in `scripts/deployment-smoke.ts` (not yet executed successfully). |
| Interactive setup, generated configuration, input validation, cancellation, and config backups | `tests/deployment/setup.test.ts`; real package installation, certificate issuance, and system service changes require verification on a deployment host. |
| Host TLS, certificate renewal, gateway discovery, upgrade/rollback, volume permissions and backup exclusions | Operator checklist and commands in `DEPLOYMENT.md`; these host-specific steps require verification on the deployment host. |

The files above identify the assertions to run, not a blanket promise of complete coverage. State the commands and results from the current checkout when reporting verification.
