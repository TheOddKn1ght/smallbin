# Smallbin

Private, temporary text and file sharing. No account required. Text, filenames, and file bytes are encrypted in your browser; the decryption key stays in the share link's URL fragment.

- Share text, one file, or both; files up to 100 MB and text up to 1 MB.
- Choose expiry from 5 minutes to 12 hours.
- Copy a link or a locally generated QR code.
- Self-host with Bun, Drizzle, SQLite, and encrypted files on local disk.

Anyone with the complete link can decrypt a bin. The server still sees ciphertext sizes and request timing. Browser history and downloaded copies can outlive expiry. This does not protect against a compromised browser or a server that changes the delivered JavaScript.

## Development

Use Bun 1.4.2:

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
