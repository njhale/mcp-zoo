#!/usr/bin/env node
/**
 * reflect-mcp — a debug MCP server with a single `echo` tool. Always returns:
 *  - the command and args this process was launched with (process.argv)
 *  - process metadata (cwd, pid, execPath, node version, platform, arch)
 *
 * Plus, transport-dependent:
 *  - on the streamable HTTP transport: the inbound request headers, redacted
 *    by default. Env is intentionally NOT returned over HTTP — exposing it
 *    via a network-reachable endpoint would be a casual exfiltration vector
 *    even with redaction (key names alone reveal which credentials are set).
 *  - on stdio: process.env, redacted by default. No headers (stdio has none).
 *
 * Pass the per-process echo key (printed on stderr at startup) as the `key`
 * argument to receive unredacted env / headers. Without it (or with a wrong
 * value) values are replaced with `********`. The key gate keeps the tool
 * from being a casual exfiltration vector — anyone who can tail the server's
 * stderr can call it with real values, but a random caller who just
 * discovered an MCP endpoint sees only `********`.
 *
 * Designed for verifying obot/nanobot wiring: secret bindings, header
 * propagation, env var visibility, runtime configuration.
 */

import { randomUUID, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { type Request, type Response } from "express";
import { z } from "zod";

// Snapshot at startup — the tool always returns the original launch argv even
// if the process later mutates process.argv. Includes EVERY arg, recognized
// or not, so callers can pass arbitrary extra args (in the catalog entry, or
// directly on the command line) and see them surfaced verbatim by the echo
// tool. parseArgs() also collects the unrecognized subset into extraArgs for
// convenience.
const ARGV_SNAPSHOT: readonly string[] = Object.freeze([...process.argv]);

// Per-process echo key. Generated fresh on every startup, printed to stderr
// once via announceEchoKey(), and required as the `key` argument to receive
// unredacted env / headers from the echo tool. Without it (or with a
// mismatch) values are replaced with REDACTED.
const ECHO_KEY = randomUUID();
const REDACTED = "********";

type TransportName = "http-streamable" | "stdio";

interface CliOpts {
  transport: TransportName;
  port: number;
  path: string;
  /**
   * Args that the parser did NOT recognize as one of the real flags
   * (--transport, --port, --path, -h/--help). These are passed through
   * untouched and surfaced in the `echo` tool's response so callers can
   * supply arbitrary extra args (e.g. via the catalog entry's
   * `npxConfig.args` / `containerizedConfig.args`) and verify they
   * arrive — useful for debugging how nanobot/obot construct argv.
   */
  extraArgs: string[];
}

function parseArgs(argv: readonly string[]): CliOpts {
  let transport: TransportName = "http-streamable";
  let port = 8099;
  let path = "/mcp";
  const extraArgs: string[] = [];

  const setTransport = (v: string) => {
    if (v !== "http-streamable" && v !== "stdio") {
      throw new Error(
        `unsupported --transport ${JSON.stringify(v)}; want one of: http-streamable | stdio`,
      );
    }
    transport = v;
  };

  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--transport") {
      setTransport(argv[++i] ?? "");
    } else if (a.startsWith("--transport=")) {
      setTransport(a.slice("--transport=".length));
    } else if (a === "--port") {
      port = Number.parseInt(argv[++i] ?? "", 10);
    } else if (a.startsWith("--port=")) {
      port = Number.parseInt(a.slice("--port=".length), 10);
    } else if (a === "--path") {
      path = argv[++i] ?? "/mcp";
    } else if (a.startsWith("--path=")) {
      path = a.slice("--path=".length);
    } else if (a === "-h" || a === "--help") {
      printUsage();
      process.exit(0);
    } else {
      // Pass-through. Anything we don't recognize is preserved in argv (and
      // collected here as a convenience field) so the echo tool can surface
      // it verbatim. This is a debug server — accepting arbitrary args is
      // a feature, not a bug.
      extraArgs.push(a);
    }
  }

  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid --port: ${port}`);
  }
  if (!path.startsWith("/")) {
    throw new Error(`--path must start with '/': got ${JSON.stringify(path)}`);
  }
  return { transport, port, path, extraArgs };
}

function printUsage(): void {
  process.stderr.write(
    [
      "reflect-mcp — debug MCP server",
      "",
      "Usage: reflect-mcp [--transport http-streamable|stdio] [--port N] [--path /mcp] [<arbitrary extra args...>]",
      "",
      "  --transport   Transport to use. Default: http-streamable.",
      "  --port        TCP port for http-streamable. Default: 8099.",
      "  --path        URL path for the MCP endpoint. Default: /mcp.",
      "",
      "Any other arguments are passed through unchanged and surfaced verbatim",
      "via the `echo` tool's `argv` and `extraArgs` fields. This makes",
      "reflect-mcp useful for verifying how nanobot/obot construct argv when",
      "launching MCP servers (e.g. catalog `npxConfig.args`).",
      "",
      "The single tool, 'echo', returns argv, env, cwd, pid, transport, and",
      "(for HTTP) the inbound request headers.",
      "",
    ].join("\n"),
  );
}

/**
 * Constant-time comparison of the supplied key against ECHO_KEY. Avoids
 * leaking match progress through timing differences. timingSafeEqual requires
 * equal-length buffers, so length-mismatch rejects up front (which is fine —
 * length parity isn't a meaningful secret here).
 */
function isAuthorized(provided: string | undefined): boolean {
  if (typeof provided !== "string") return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(ECHO_KEY);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Replace every value in an env map with REDACTED. Keys are preserved. */
function redactEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(env)) {
    out[k] = REDACTED;
  }
  return out;
}

/**
 * Replace every header value with REDACTED. Preserves multi-value headers
 * (which Node represents as string[]) so the structure round-trips.
 */
function redactHeaders(
  headers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = Array.isArray(v) ? v.map(() => REDACTED) : REDACTED;
  }
  return out;
}

/**
 * One-shot stderr banner with the echo key. Called once at startup, before
 * any transport is connected. stderr is safe to write to even on stdio
 * transport (stdout is the only thing reserved for MCP framing).
 */
function announceEchoKey(): void {
  process.stderr.write(
    [
      "",
      "═══════════════════════════════════════════════════════════════════════",
      `reflect-mcp echo key: ${ECHO_KEY}`,
      "",
      "Pass this as the `key` argument to the echo tool to receive UNREDACTED",
      `env vars and HTTP headers. Without it, values are replaced with '${REDACTED}'.`,
      "═══════════════════════════════════════════════════════════════════════",
      "",
    ].join("\n"),
  );
}

function buildServer(opts: CliOpts): McpServer {
  const server = new McpServer({
    name: "reflect-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description:
        "Returns the command and args this server was launched with (including any arbitrary extras), plus process metadata. Over the streamable HTTP transport, the response also includes inbound request headers. Over stdio it instead includes the process env. Header / env values are redacted by default — pass the `key` argument (printed on stderr at server startup) to receive unredacted output. Useful for verifying secret bindings, header propagation, env-var propagation, and runtime configuration of MCP server deployments.",
      inputSchema: {
        // SDK v1 wants a ZodRawShape (object of field → ZodType), not a
        // wrapped z.object({...}).
        key: z
          .string()
          .optional()
          .describe(
            "Echo key printed to stderr at startup. When matched, env vars / HTTP headers are returned unredacted. Without it (or with a mismatch) values are replaced with '********'.",
          ),
      },
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
    },
    async ({ key }, extra) => {
      const authorized = isAuthorized(key);

      // In streamable-HTTP mode, the SDK populates extra.requestInfo.headers
      // with the headers of the inbound HTTP request that triggered this
      // tool call. In stdio mode this is undefined — and stdio is the only
      // mode in which we surface process.env at all.
      const requestInfo = (
        extra as { requestInfo?: { headers?: Record<string, string | string[]> } } | undefined
      )?.requestInfo;
      const rawHeaders = requestInfo?.headers ?? null;
      const isHTTP = rawHeaders !== null;

      // Common fields, returned regardless of transport.
      const common = {
        // Full argv as captured at startup, byte-for-byte. Any arbitrary
        // extra args supplied by the caller appear here.
        argv: ARGV_SNAPSHOT,
        // Subset of argv that was NOT consumed by reflect-mcp's own flags
        // — convenience field for callers who just want "the extras".
        extraArgs: opts.extraArgs,
        // The flags reflect-mcp itself recognized.
        recognizedFlags: {
          transport: opts.transport,
          port: opts.port,
          path: opts.path,
        },
        execPath: process.execPath,
        cwd: process.cwd(),
        pid: process.pid,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        transport: isHTTP ? "http-streamable" : "stdio",
        // True when the response would have been redacted — i.e. when the
        // key didn't match. Lets callers distinguish "value is literally
        // ********" from "we redacted a real value".
        redacted: !authorized,
        receivedAt: new Date().toISOString(),
      };

      // Transport-conditional fields. HTTP responses NEVER include env —
      // anything reachable over the network is a casual exfiltration vector
      // even when redacted (key names alone leak which credentials are
      // present). stdio responses include env (gated by the key) but never
      // headers (stdio has none).
      const result = isHTTP
        ? {
            ...common,
            headers: authorized ? rawHeaders : redactHeaders(rawHeaders),
          }
        : {
            ...common,
            env: authorized ? process.env : redactEnv(process.env),
          };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

async function runStdio(opts: CliOpts): Promise<void> {
  const server = buildServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is reserved for MCP JSON-RPC framing.
  console.error("reflect-mcp listening on stdio");
}

async function runHTTP(opts: CliOpts): Promise<void> {
  const server = buildServer(opts);
  const { port, path: mcpPath } = opts;
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ ok: true });
  });

  app.post(mcpPath, async (req: Request, res: Response) => {
    try {
      // Stateless: a fresh transport per request. sessionIdGenerator=undefined
      // tells the SDK we don't manage sessions.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      res.on("close", () => {
        transport.close().catch(() => {});
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("error handling MCP request:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  // Stateless mode: explicitly reject GET/DELETE on the MCP path so clients
  // get a clean error rather than hanging.
  app.all(mcpPath, (req: Request, res: Response, next) => {
    if (req.method === "POST") return next();
    res.status(405).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed in stateless mode (POST only)",
      },
      id: null,
    });
  });

  app.listen(port, () => {
    console.error(`reflect-mcp listening on :${port}${mcpPath} (transport: http-streamable)`);
  });
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv);
  // Print the per-process echo key once before any transport is connected.
  announceEchoKey();
  if (opts.transport === "stdio") {
    await runStdio(opts);
  } else {
    await runHTTP(opts);
  }
}

main().catch((err) => {
  console.error("reflect-mcp fatal:", err);
  process.exit(1);
});
