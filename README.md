# Smallbin

Private, temporary text and file sharing. No account required. Text, filenames, and file bytes are encrypted in your browser; the decryption key stays in the share link's URL fragment.

- Share text, multiple files, or both; attachments total up to 100 MB, with a separate 1 MB text limit.
- Choose expiry from 5 minutes to 12 hours.
- Copy a link or a locally generated QR code.
- Self-host with Bun, Drizzle, SQLite, and encrypted files on local disk.

Anyone with the complete link can decrypt a bin. The server still sees ciphertext sizes and request timing. Browser history and downloaded copies can outlive expiry. This does not protect against a compromised browser or a server that changes the delivered JavaScript.

New bins use encrypted format v2 for multiple attachments. Existing v1 links remain readable in the current app; deploy frontend and server from the same image when upgrading.

## Development

Use Bun 1.4.3:

```sh
bun install --frozen-lockfile
bun run dev
```

Open [http://localhost:3210](http://localhost:3210). Set `PORT` to override the default. New package versions must be at least 14 days old; the policy is in `bunfig.toml`.

Production startup serves the built assets and requires `PUBLIC_ORIGIN`:

```sh
bun run build
PUBLIC_ORIGIN=https://bin.example.com bun run start
```

Production also defaults to port 3210. Put nginx with HTTPS in front of this process; the development server is intended for localhost.

Development, production, and the Docker container run Bun with `--smol` to reduce memory use by collecting garbage more often. The 14-day package-age policy still applies to dependency updates; the Bun runtime is pinned separately.

```sh
bun run test
bun run test:coverage
bun run test:e2e
```

See [TESTING.md](TESTING.md) for browser and deployment checks, and [DEPLOYMENT.md](DEPLOYMENT.md) for Docker, nginx, TLS, migrations, and upgrades.

## Server setup

On a Debian/Ubuntu server with your domain pointing to it:

```sh
bash scripts/setup.sh
```

Use `bash scripts/setup.sh --prepare-only` to generate configuration without changing the host. See [DEPLOYMENT.md](DEPLOYMENT.md#interactive-setup) for prerequisites and rerun behavior.

After updating this checkout, rebuild and deploy with the existing settings and certificate:

```sh
bash scripts/setup.sh --update
```

The update keeps the data volume and previous image. It builds the replacement before restarting the app; review migration compatibility before rolling back.
