# mcp-zoo

A small collection of [Model Context Protocol](https://modelcontextprotocol.io) servers and a catalog file describing how to install them under [obot](https://github.com/obot-platform/obot).

Each server lives in its own subdirectory with its own build, image, and (where applicable) npm package. The repo-level [`catalog.yaml`](catalog.yaml) declares one or more obot-compatible catalog entries per server, covering the runtimes that server supports (`npx`, `containerized`, `remote`, `uvx`, `composite`).

## Layout

```
mcp-zoo/
├── catalog.yaml                  # obot catalog entries — one document, list of entries
├── reflect-mcp/                  # debug MCP server: echoes argv, env, headers
│   ├── src/                      # TypeScript sources
│   ├── Dockerfile                # multi-stage chainguard build
│   ├── package.json              # publishes as @njhale/reflect-mcp
│   └── README.md
└── .github/workflows/            # CI: docker build/push, optional npm publish
```

## Servers

| Server | What it does | Runtimes |
|---|---|---|
| [reflect-mcp](reflect-mcp/) | Single `echo` tool that returns the launch command/args, env, and inbound HTTP headers. Useful for verifying obot/nanobot wiring (secret bindings, header propagation, env-var visibility). | `npx`, `containerized`, `remote` |

## Using the catalog with obot

Point an obot `MCPCatalog` at this repo:

1. In **Admin → MCP Servers → Catalogs**, add a catalog source with URL `https://github.com/njhale/mcp-zoo`.
2. obot's `mcpcatalog` controller clones the repo, walks `catalog.yaml`, and creates one `MCPServerCatalogEntry` per list element.
3. The entries become available in the regular MCP server picker.

Catalog entries in this repo are GitOps-managed — they're code-reviewed via PR and synced from git. Per the [external-secrets feature](https://github.com/obot-platform/obot/issues/6180), this is the only place `secretBinding` references on env vars / headers are accepted.

## Adding a new server

1. Create a top-level directory with the server's source, Dockerfile, and language-specific build files.
2. Add a CI workflow under `.github/workflows/<server>-<purpose>.yaml` (use the `reflect-mcp` workflows as a template).
3. Append one or more entries to [`catalog.yaml`](catalog.yaml) — one per runtime variant you want to expose.
4. Open a PR. The catalog entries are validated on the obot side at sync time, so unsupported runtime configurations are rejected before they hit users.

## License

MIT — see individual subdirectories for any per-package license overrides.
