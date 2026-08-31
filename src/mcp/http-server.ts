import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createFinanceMcpServer, type FinanceReadService } from "./create-mcp-server";

export interface McpHttpServerOptions {
  host: "127.0.0.1";
  port: number;
  path: string;
  rateLimitPerMinute: number;
  bearerToken?: string;
  maxBodyBytes?: number;
}

export interface McpHttpServerStatus {
  state: "stopped" | "starting" | "running" | "error";
  endpoint?: string;
  lastError?: string;
}

export class McpHttpServer {
  private server?: Server;
  private statusValue: McpHttpServerStatus = { state: "stopped" };
  private readonly buckets = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly service: FinanceReadService,
    private readonly options: McpHttpServerOptions
  ) {}

  get status(): McpHttpServerStatus {
    return { ...this.statusValue };
  }

  async start(): Promise<McpHttpServerStatus> {
    if (this.server) return this.status;
    this.statusValue = { state: "starting" };

    const server = createServer((request, response) => {
      void this.route(request, response);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.options.port, this.options.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
      this.server = server;
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : this.options.port;
      this.statusValue = {
        state: "running",
        endpoint: `http://${this.options.host}:${port}${this.options.path}`
      };
      return this.status;
    } catch (error) {
      server.close();
      this.statusValue = {
        state: "error",
        lastError: error instanceof Error ? error.message : "Unable to start the MCP server."
      };
      throw error;
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
    this.statusValue = { state: "stopped" };
    this.buckets.clear();
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      this.applySecurityHeaders(response);
      if (!this.isLoopbackRequest(request) || !this.hasValidHostHeader(request)) {
        return this.json(response, 403, { error: "forbidden" });
      }
      if (request.headers.origin) {
        return this.json(response, 403, { error: "browser_origins_not_accepted" });
      }
      if (!this.withinRateLimit(request)) {
        response.setHeader("Retry-After", "60");
        return this.json(response, 429, { error: "rate_limited" });
      }
      if (!this.isAuthorized(request)) {
        response.setHeader("WWW-Authenticate", 'Bearer realm="amex-local-mcp"');
        return this.json(response, 401, { error: "unauthorized" });
      }

      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (url.pathname === "/healthz" && request.method === "GET") {
        return this.json(response, 200, { status: "ok", transport: "streamable-http", scope: "loopback" });
      }
      if (url.pathname !== this.options.path) {
        return this.json(response, 404, { error: "not_found" });
      }
      if (request.method !== "POST") {
        response.setHeader("Allow", "POST");
        return this.json(response, 405, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed." },
          id: null
        });
      }
      if (!request.headers["content-type"]?.toLowerCase().includes("application/json")) {
        return this.json(response, 415, { error: "content_type_must_be_application_json" });
      }

      const body = await this.readJsonBody(request);
      const mcpServer = createFinanceMcpServer(this.service);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await mcpServer.connect(transport);
      response.on("close", () => {
        void transport.close();
        void mcpServer.close();
      });
      await transport.handleRequest(request, response, body);
    } catch (error) {
      if (!response.headersSent) {
        const isClientError = error instanceof RequestBodyError;
        this.json(response, isClientError ? error.status : 500, {
          jsonrpc: "2.0",
          error: {
            code: isClientError ? -32600 : -32603,
            message: isClientError ? error.message : "Internal server error"
          },
          id: null
        });
      } else {
        response.end();
      }
    }
  }

  private readJsonBody(request: IncomingMessage): Promise<unknown> {
    const maximum = this.options.maxBodyBytes ?? 1_048_576;
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      request.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maximum) {
          reject(new RequestBodyError(413, "Request body is too large."));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(new RequestBodyError(400, "Request body is not valid JSON."));
        }
      });
      request.on("error", reject);
    });
  }

  private isLoopbackRequest(request: IncomingMessage): boolean {
    const address = request.socket.remoteAddress;
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  }

  private hasValidHostHeader(request: IncomingMessage): boolean {
    const host = request.headers.host?.toLowerCase();
    if (!host) return false;
    return host === "127.0.0.1" || host.startsWith("127.0.0.1:") || host === "localhost" || host.startsWith("localhost:");
  }

  private isAuthorized(request: IncomingMessage): boolean {
    if (!this.options.bearerToken) return true;
    return request.headers.authorization === `Bearer ${this.options.bearerToken}`;
  }

  private withinRateLimit(request: IncomingMessage): boolean {
    const key = request.socket.remoteAddress ?? "loopback";
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= 60_000) {
      this.buckets.set(key, { windowStart: now, count: 1 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= this.options.rateLimitPerMinute;
  }

  private applySecurityHeaders(response: ServerResponse): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.statusCode = status;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify(value));
  }
}

class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}
