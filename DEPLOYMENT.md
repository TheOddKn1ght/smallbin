# Deploy Smallbin

The supported production layout is one Bun container with a local Docker volume, behind nginx on the same Linux host. nginx terminates HTTPS; the app is published only on `127.0.0.1`. SQLite metadata, its WAL files, pending uploads, and encrypted files share `/data`. Do not run multiple application replicas or mount this volume over a network filesystem.

You need Docker Engine with the Compose plugin, nginx, Certbot, a domain pointing to the host, and inbound TCP ports 80 and 443. The local verification commands also require Bun 1.4.2. Keep port 3210 private. Browser encryption requires HTTPS, except for browser development on localhost. The commands below assume a Debian/Ubuntu host and a checkout of this repository.

## First deployment

Install Docker Engine and its Compose plugin using the [official Ubuntu guide](https://docs.docker.com/engine/install/ubuntu/) or your distribution's supported instructions. With Docker installed:

```sh
sudo apt-get update
sudo apt-get install nginx certbot
docker version
docker compose version
```

Copy the configuration and set your actual domain:

```sh
cp .env.example .env
```

Edit `.env`, setting `PUBLIC_ORIGIN=https://bin.example.com`. Replace `bin.example.com` with your domain in both nginx templates. Do not put a trailing slash in `PUBLIC_ORIGIN`. Leave `TRUSTED_PROXIES` empty until the network exists.

Run the checks and build a versioned image:

```sh
bun install --frozen-lockfile
bun run test
bun run test:coverage
SMALLBIN_IMAGE=smallbin:initial docker compose build
```

Set `SMALLBIN_IMAGE=smallbin:initial` in `.env`. The Docker build uses Bun 1.4.2 and runs the production application build. The committed lockfile is required. `bunfig.toml` requires packages to be at least 14 days old when resolving new versions; do not bypass this policy when updating dependencies.

Create the stopped container and inspect its Docker network gateway:

```sh
docker compose create
docker network inspect smallbin_default --format '{{range .IPAM.Config}}{{println .Gateway}}{{end}}'
```

Set `TRUSTED_PROXIES` in `.env` to the exact IPv4 gateway printed above, for example `172.20.0.1`. Do not use that example without inspecting your network, a whole private address range, or `0.0.0.0/0`. With native Linux Docker bridge networking, connections from host nginx through the loopback-published port arrive at the container through this gateway. Different Docker networking arrangements must establish their actual peer address before enabling forwarded-IP trust.

nginx overwrites `X-Forwarded-For` with its directly connected client's IP. The app only accepts that header from an explicitly trusted transport peer. A wrong gateway setting groups nginx clients under one throttle bucket; an overly broad setting allows spoofing. Keep the application port private and do not place unrelated containers on its network. Recheck the gateway after recreating the Compose network.

Start the app:

```sh
docker compose up -d --no-build --wait
curl --fail --silent http://127.0.0.1:3210/healthz
docker compose ps
```

Migrations run before the app listens. Startup also removes abandoned partial uploads and reconciles expired or orphaned files. A migration, storage, or single-instance-lock error prevents startup. The readiness endpoint returns no bin details. Docker marks unhealthy containers but does not restart a process solely because its healthcheck fails; `unless-stopped` restarts processes that exit.

## HTTPS and nginx

Prepare the ACME challenge directory and install the HTTP bootstrap template after replacing its example domain:

```sh
sudo install -d -m 755 /var/www/letsencrypt
sudo install -m 644 deploy/nginx-http.conf.template /etc/nginx/conf.d/smallbin.conf
sudo nginx -t
sudo systemctl reload nginx
sudo certbot certonly --webroot -w /var/www/letsencrypt -d bin.example.com
```

Use your actual domain in the Certbot command. Ensure another nginx configuration does not already claim the same domain. After the certificate exists, install the HTTPS template:

```sh
sudo install -m 644 deploy/nginx.conf.template /etc/nginx/conf.d/smallbin.conf
sudo nginx -t
sudo systemctl reload nginx
curl --fail --silent --head https://bin.example.com/
```

Enable your distribution's Certbot renewal timer and arrange a successful-renewal reload:

```sh
sudo install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
printf '%s\n' '#!/bin/sh' 'nginx -t && systemctl reload nginx' | sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx >/dev/null
sudo chmod 755 /etc/letsencrypt/renewal-hooks/deploy/reload-nginx
sudo systemctl enable --now certbot.timer
sudo certbot renew --dry-run
```

The template disables request/response buffering, proxy caching, request retries, and request-bearing access/error logs. Its `102m` request limit accommodates the 100 MB file limit plus 1 MB of text and encryption metadata; the app independently validates its precise ciphertext limit. nginx timeouts measure inactivity, while app upload/download deadlines also bound transfer duration. If your users need slower transfers, raise the appropriate app timeout and nginx timeout together, then recreate the app and reload nginx.

nginx replaces the app's cache/referrer/content-type headers once and preserves its CSP through a mapped value. nginx-generated errors receive the same privacy headers and a restrictive fallback CSP. HSTS is enabled for this hostname only. The public `/healthz` endpoint is hidden; use the loopback endpoint for operations.

Open the HTTPS site in a browser and create a text-and-file bin, open the full link in a separate browser session, and confirm the downloaded file. Check that the expiry time and missing-key messages behave as expected. The URL fragment holds the key and must not be removed when sharing.

## Configuration and storage

| Variable | Default | Meaning |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | Required in production | Browser-facing HTTPS origin used for request validation. |
| `PORT` | `3210` | Loopback host port in Compose; internal container port stays 3210. Change nginx's upstream if changed. |
| `SMALLBIN_IMAGE` | `smallbin:local` | Local or registry image tag; pin a release tag or digest for upgrades. |
| `TRUSTED_PROXIES` | Empty | Comma-separated proxy IPs/CIDRs; canonical deployment uses only its inspected bridge gateway. |
| `MAX_STORAGE_BYTES` | `10000000000` | Ciphertext quota including pending uploads; leave additional filesystem room for SQLite and OS overhead. |
| `UPLOAD_TIMEOUT_MS` | `120000` | App upload deadline in milliseconds. |
| `DOWNLOAD_TIMEOUT_MS` | `120000` | App download deadline in milliseconds. |
| `DATA_DIR` | `./data` outside Docker | Persistent directory; fixed to `/data` in Compose. |
| `MIGRATIONS_DIR` | Application default | Docker fixes this to `/app/drizzle`; includes committed migrations. |

The image runs as the non-root `bun` user. Docker initializes the fresh `smallbin_smallbin-data` named volume from the image's `/data` directory with the right owner and mode `0700`. The root filesystem is read-only; only `/data` and a 64 MiB `/tmp` tmpfs are writable. Never solve a permissions error with world-writable storage.

If replacing the named volume with a bind mount, prepare the host directory first. Read the image's numeric UID/GID rather than assuming your host account matches it:

```sh
docker run --rm --entrypoint id smallbin:initial bun
sudo install -d -m 700 /srv/smallbin/data
```

Then `chown` that directory to the printed UID/GID and mount it at `/data`. Keep the database, `-wal`/`-shm` files, lock database, `blobs/`, and `tmp/` together. Do not copy a live SQLite database file by itself. Do not remove lock files while the application runs.

## Upgrades, rollback, and shutdown

Test the new code, then build a new image tag without overwriting the old one:

```sh
bun install --frozen-lockfile
bun run test
bun run test:coverage
SMALLBIN_IMAGE=smallbin:release-2 docker compose build
```

Set `SMALLBIN_IMAGE=smallbin:release-2` in `.env`, then:

```sh
docker compose up -d --no-build --wait
curl --fail --silent http://127.0.0.1:3210/healthz
docker compose ps
```

Committed Drizzle migrations apply automatically on startup, once each. Do not use `drizzle-kit push` or generate migrations on the production host. Review schema changes before upgrading. Returning to the previous image is safe only when it supports the migrated schema; there are no automatic down migrations. For an incompatible rollback, stop service and plan an explicit reset of disposable bin data rather than pointing old code at an unsupported database. Tell users that resetting storage invalidates existing links.

Stop without deleting data:

```sh
docker compose stop
```

`docker compose down` removes the container/network but retains the volume; inspect the new gateway before restarting after network recreation. **`docker compose down -v` permanently removes stored bins.**

## Privacy and operational checks

The browser encrypts text, attachment bytes, filenames, and MIME metadata before upload. The service never receives the fragment key. It still sees ciphertext size, timing, and network connections. Temporary throttling identifiers are kept in memory. The server can serve modified application JavaScript, so this architecture does not protect against a malicious hosting operator or compromised client code.

Exclude the data volume, host snapshots containing it, and nginx temporary data from backups. Do not enable access logs, debug request logging, tracing, third-party analytics/CDNs, or crash dumps containing application memory. The nginx template discards request errors as well as access logs; troubleshoot with health status, process startup errors, disk usage, and local synthetic requests. Temporarily enabling diagnostic request logs changes the privacy guarantees and may retain client IPs/bin paths.

Expiry immediately blocks new downloads. Cleanup removes expired ciphertext shortly afterward; an already-started download may finish. Files already downloaded, browser history, and recipient copies cannot be recalled. Deletion is not a promise of physical erasure from SSDs, host snapshots, swap, or provider infrastructure.

Run the disposable Docker/nginx smoke suite after building an image, as described in [TESTING.md](TESTING.md). It checks startup readiness, private port publication, encrypted upload/download, restart persistence, expiry headers, reverse-proxy headers, and cleanup. It uses separate temporary volumes and never touches production data.
