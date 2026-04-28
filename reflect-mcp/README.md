# @njhale/reflect-mcp

A debug MCP server with one tool — `echo` — that returns the command and args this process was launched with, the environment it sees, and (when running over HTTP) the inbound request headers.

Useful for verifying [obot](https://github.com/obot-platform/obot) / [nanobot](https://github.com/nanobot-ai/nanobot) wiring end‑to‑end:

- Are env vars from a catalog entry actually reaching the spawned MCP process?
- Are env‑var bindings against a Kubernetes Secret being projected onto the right env var name?
- Are HTTP headers (static, user‑supplied, or `secretBinding`-backed) propagated through nanobot to the upstream call?
- Are extra args appended to `npxConfig.args` / `containerizedConfig.args` arriving in `process.argv`?

## Quick start

### From npm (recommended)

```bash
# stdio
npx @njhale/reflect-mcp --transport stdio

# streamable HTTP on :8099/mcp
npx @njhale/reflect-mcp --transport http-streamable --port 8099 --path /mcp
```

### From the prebuilt container image

```bash
docker run --rm -p 8099:8099 \
  ghcr.io/njhale/mcp-zoo/reflect-mcp:main
```

The default `CMD` runs the streamable HTTP transport on `:8099/mcp`. Override `CMD` to use stdio:

```bash
docker run --rm -i ghcr.io/njhale/mcp-zoo/reflect-mcp:main --transport stdio
```

### From source

```bash
git clone https://github.com/njhale/mcp-zoo
cd mcp-zoo/reflect-mcp
pnpm install
pnpm run build
node dist/index.js --transport stdio
```

## Usage

```text
reflect-mcp [--transport http-streamable|stdio] [--port N] [--path /mcp] [<arbitrary extra args...>]

  --transport   Transport to use. Default: http-streamable.
  --port        TCP port for http-streamable. Default: 8099.
  --path        URL path for the MCP endpoint. Default: /mcp.

Any other arguments are passed through unchanged and surfaced verbatim
via the `echo` tool's `argv` and `extraArgs` fields. This makes
reflect-mcp useful for verifying how nanobot/obot construct argv when
launching MCP servers (e.g. catalog `npxConfig.args`).
```

## The `echo` tool

One optional parameter, `key`. The response shape depends on the transport:

| Transport | `argv` + metadata | `headers` | `env` |
|---|---|---|---|
| **streamable HTTP** | ✓ | ✓ (redacted by default) | omitted |
| **stdio**           | ✓ | omitted (stdio has none) | ✓ (redacted by default) |

`env` is **never** returned over the streamable HTTP transport — exposing it on a network-reachable endpoint would be a casual exfiltration vector even with redaction (the key names alone reveal which credentials are set). Use the stdio variant to inspect env. `headers` are gated by the `key` over HTTP since they routinely carry `Authorization` tokens and the like.

### HTTP, default (headers redacted, no env)

```jsonc
// tools/call → { "name": "echo", "arguments": {} }
{
  "argv": [
    "/usr/bin/node",
    "/app/dist/index.js",
    "--transport", "http-streamable",
    "--port", "8099",
    "--path", "/mcp",
    "--reflect-tag=containerized",
    "hello-from-catalog"
  ],
  "extraArgs": ["--reflect-tag=containerized", "hello-from-catalog"],
  "recognizedFlags": { "transport": "http-streamable", "port": 8099, "path": "/mcp" },
  "execPath": "/usr/bin/node",
  "cwd": "/app",
  "pid": 1,
  "nodeVersion": "v24.x.x",
  "platform": "linux",
  "arch": "amd64",
  "transport": "http-streamable",
  "redacted": true,
  "receivedAt": "2026-04-28T12:34:56.789Z",
  "headers": {
    "host":            "********",
    "x-reflect-test":  "********",
    "x-reflect-token": "********",
    "authorization":   "********"
  }
  // no `env` field over HTTP
}
```

### HTTP, with the key (headers unredacted, still no env)

At server startup, stderr prints something like:

```
═══════════════════════════════════════════════════════════════════════
reflect-mcp echo key: 7c2e1f4a-3b9d-4e8c-9a51-1f6b2d3a4c5e

Pass this as the `key` argument to the echo tool to receive UNREDACTED
env vars and HTTP headers. Without it, values are replaced with '********'.
═══════════════════════════════════════════════════════════════════════
```

Then:

```jsonc
// tools/call → { "name": "echo", "arguments": { "key": "7c2e1f4a-..." } }
{
  // ...same shape as above, but with real header values; still no env...
  "headers": {
    "authorization":   "Bearer eyJhbG...",
    "x-reflect-test":  "hello-from-obot",
    "x-reflect-token": "actual-token",
    "host":            "reflect-mcp-abc12.obot-mcp.svc:80"
  },
  "redacted": false
}
```

### stdio, with the key (env unredacted)

```jsonc
// tools/call → { "name": "echo", "arguments": { "key": "7c2e1f4a-..." } }
{
  // ...same metadata fields as HTTP...
  "transport": "stdio",
  "redacted": false,
  "env": {
    "DD_API_KEY":          "abc123def456",   // ← projected via valueFrom.secretKeyRef
    "REFLECT_TEST_SECRET": "actual-secret",
    "REFLECT_TEST_VALUE":  "hello",
    "PATH":                "/usr/local/bin:/usr/bin:/bin"
  }
  // no `headers` field on stdio
}
```

### Field notes

- **`argv`** — captured at process startup, byte-for-byte. Never redacted (redacting would defeat the point of verifying how nanobot/obot constructs argv). Don't put secrets in argv.
- **`extraArgs`** — convenience field listing the args that were *not* consumed by `--transport` / `--port` / `--path`.
- **`recognizedFlags`** — what reflect-mcp actually parsed.
- **`env`** — full `process.env`. **Only present on stdio.** Includes whatever obot's runner injected via `envFrom` and whatever kubelet projected via `valueFrom.secretKeyRef`. Values redacted by default.
- **`headers`** — inbound HTTP request headers. **Only present on streamable HTTP.** Read from `extra.requestInfo.headers` per [SDK migration docs](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration.md). Values redacted by default.
- **`redacted`** — `true` when the conditional field (env on stdio, headers on HTTP) has been redacted; `false` when the key matched and real values are returned. Lets the caller distinguish "received `********`" from "the value is literally `********`."

## Health check

When running the HTTP transport, `GET /healthz` returns `{ "ok": true }` (port `8099` by default). Stdio mode has no health endpoint.

## Catalog integration

Three obot catalog entries shipped from this repo's [`catalog.yaml`](../catalog.yaml):

```yaml
# npx, single-user, stdio
- runtime: npx
  npxConfig:
    package: "@njhale/reflect-mcp"
    args: [--transport, stdio, --reflect-tag=npx-single-user, hello-from-catalog]
  env:
    - { key: REFLECT_TEST_VALUE,  required: false, sensitive: false }
    - { key: REFLECT_TEST_SECRET, required: false, sensitive: true  }

# containerized, multi-user, HTTP
- runtime: containerized
  containerizedConfig:
    image: ghcr.io/njhale/mcp-zoo/reflect-mcp:main
    port: 8099
    path: /mcp
    args: [--transport, http-streamable, --port, "8099", --path, /mcp, --reflect-tag=containerized, hello-from-catalog]
  env:
    - { key: REFLECT_TEST_VALUE,  required: false, sensitive: false }
    - { key: REFLECT_TEST_SECRET, required: false, sensitive: true  }

# remote, hosted
- runtime: remote
  remoteConfig:
    fixedURL: https://reflect.scrat.hale.sh/mcp
    headers:
      - { key: X-Reflect-Test,  value: hello-from-obot, sensitive: false }  # static
      - { key: X-Reflect-Token, sensitive: true }                            # user-supplied
```

The remote variant is also a good place to attach a `secretBinding` to verify the external-secrets feature against a pre-existing Kubernetes Secret.

## Build & develop

Requires Node `>=24` and pnpm (managed via the `packageManager` field — corepack will install the right version).

```bash
pnpm install              # install deps
pnpm dev                  # tsx src/index.ts (no build step)
pnpm build                # tsc → dist/
pnpm lint                 # biome check
pnpm lint:fix             # biome check --write (lint + format auto-fix)
pnpm typecheck            # tsc --noEmit
pnpm clean                # rm -rf dist node_modules
```

To wipe the lockfile too (rare): `pnpm clean && rm -f pnpm-lock.yaml && pnpm install`.

### Local dev behind a Cloudflare tunnel

For testing the HTTP transport against a real public URL (e.g. so an obot/nanobot instance running elsewhere can reach it), reflect-mcp ships scripts for [cloudflared](https://github.com/cloudflare/cloudflared) integration.

**One-time setup** (per environment, idempotent):

```bash
brew install cloudflared          # or your package manager
cloudflared tunnel login          # authenticate
cloudflared tunnel create dev   # if not already created
cloudflared tunnel route dns --overwrite-dns dev reflect.hale.sh
```

**Day-to-day**:

```bash
pnpm dev:tunnel    # runs `dev` + `tunnel` side-by-side via concurrently
                   # (named colored prefixes; ctrl-C kills both)
```

Or run the two halves independently:

```bash
pnpm dev           # terminal 1: tsx server on :8099
pnpm tunnel        # terminal 2: cloudflared → http://localhost:8099
```

Once it's up, hit `https://reflect.hale.sh/mcp` from any MCP client.

### Publishing to npm

CI publishes via [npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers) (OIDC) on push to `main` — see [`.github/workflows/reflect-mcp-npm.yaml`](../.github/workflows/reflect-mcp-npm.yaml). To release: bump `version` in `package.json` and merge to `main`. Local dry-run:

```bash
pnpm lint && pnpm typecheck && pnpm build
npm publish --dry-run --access public
```

### Container image

The Dockerfile is two-stage:

- **build**: `cgr.dev/chainguard/node:latest-dev` (Node 24, has shell + apk for the build).
- **runtime**: `cgr.dev/chainguard/node:latest` (distroless — Node + libc only). Runs as the built-in `nonroot` user (uid 65532).

```bash
# Local build (current arch only, loaded into Docker)
docker buildx build --load -t reflect-mcp:local .
docker run --rm -p 8099:8099 reflect-mcp:local

# Multi-arch build, pushed to a registry (can't `--load` multi-arch into the
# local Docker image store; push it instead)
docker buildx create --name multiarch --use --bootstrap   # one-time
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/njhale/mcp-zoo/reflect-mcp:dev \
  --push .
```

## Security note

`echo` returns `process.env` and inbound HTTP headers, redacted with `********` by default. The per-process echo key (random UUID, regenerated on every restart, printed on stderr at startup) gates unredacted access. The trust model:

- **Anyone who can call `echo` without the key** sees the *names* of env vars and headers, but every value is `********`. Useful for confirming "is `DD_API_KEY` reaching this pod?" without exposing the value itself.
- **Anyone who can read the server's stderr** can call `echo` with the key and get real values. In a Kubernetes deployment that means anyone with `kubectl logs` on the pod.

Two implications:

1. The key is ephemeral — restart the pod, key changes. There's no way to embed a fixed key. Intentional: makes "I leaked stderr to a log shipper" recoverable by restarting.
2. This is still a *debug* tool. Even with redaction in place, `echo` reveals which env-var keys are set, which headers are inbound, and what argv the process sees. Don't expose reflect-mcp to anyone you wouldn't show your `kubectl describe pod` output to.

## License

MIT.
