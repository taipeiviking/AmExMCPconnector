import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { ProviderIntegrationError, type ProviderConsentCallback } from "./provider-types";

export interface LoopbackOAuthCallbackOptions {
  /** Exact callback URI registered with the provider; only http://127.0.0.1:<port>/path is accepted. */
  readonly redirectUri: string;
  readonly expectedState: string;
  readonly timeoutMs?: number;
  readonly maximumInvalidAttempts?: number;
}

export interface LoopbackOAuthCallbackSession {
  readonly redirectUri: string;
  readonly callback: Promise<ProviderConsentCallback>;
  /** Cancels a still-pending callback and closes the listener. */
  close(): Promise<void>;
}

/**
 * Starts a bounded, one-shot OAuth callback listener before the system browser
 * is opened. It never serves financial data and releases a code only after a
 * constant-time state match.
 */
export async function startLoopbackOAuthCallbackListener(
  options: LoopbackOAuthCallbackOptions,
): Promise<LoopbackOAuthCallbackSession> {
  const parsed = validateOptions(options);
  let server: Server | undefined;
  let settled = false;
  let invalidAttempts = 0;
  let resolveCallback!: (callback: ProviderConsentCallback) => void;
  let rejectCallback!: (error: ProviderIntegrationError) => void;
  const callback = new Promise<ProviderConsentCallback>((resolvePromise, rejectPromise) => {
    resolveCallback = resolvePromise;
    rejectCallback = rejectPromise;
  });

  const finish = async (
    result:
      | { readonly kind: "success"; readonly callback: ProviderConsentCallback }
      | { readonly kind: "failure"; readonly error: ProviderIntegrationError },
  ): Promise<void> => {
    if (settled) return;
    settled = true;
    clearTimeout(timeout);
    const active = server;
    server = undefined;
    if (active) {
      await new Promise<void>((resolvePromise) => {
        const forceClose = setTimeout(() => active.closeAllConnections(), 250);
        active.close(() => {
          clearTimeout(forceClose);
          resolvePromise();
        });
        active.closeIdleConnections();
      }).catch(() => undefined);
    }
    if (result.kind === "success") resolveCallback(result.callback);
    else rejectCallback(result.error);
  };

  const requestHandler = (request: IncomingMessage, response: ServerResponse): void => {
    void (async () => {
      applySecurityHeaders(response);
      if (!isLoopback(request) || !hasExpectedHost(request, parsed.port)) {
        return respond(response, 403, "Connection refused", "This callback accepts only local requests.");
      }
      if (request.method !== "GET" || (request.url?.length ?? 0) > 16_384) {
        return respond(response, 405, "Invalid callback", "Return to the app and try connecting again.");
      }
      let url: URL;
      try {
        url = new URL(request.url ?? "", parsed.origin);
      } catch {
        return rejectAttempt(response);
      }
      if (url.pathname !== parsed.path || url.hash.length > 0) return rejectAttempt(response);
      const states = url.searchParams.getAll("state");
      const stateMatches =
        states.length === 1 && constantTimeTextEqual(parsed.expectedState, states[0] ?? "");
      if (url.searchParams.has("error")) {
        const errors = url.searchParams.getAll("error");
        if (
          !stateMatches ||
          errors.length !== 1 ||
          !isSafeOAuthError(errors[0] ?? "") ||
          url.searchParams.has("code")
        ) {
          return rejectAttempt(response);
        }
        respond(response, 400, "Authorization was not completed", "Return to the app to try again.");
        await finish({
          kind: "failure",
          error: new ProviderIntegrationError(
            "CONSENT_CANCELLED",
            "The provider authorization request was declined or failed.",
          ),
        });
        return;
      }
      const codes = url.searchParams.getAll("code");
      if (
        !stateMatches ||
        codes.length !== 1 ||
        !isSafeCode(codes[0] ?? "")
      ) {
        return rejectAttempt(response);
      }
      respond(response, 200, "Account connected", "You can close this window and return to the app.");
      await finish({ kind: "success", callback: { state: states[0] ?? "", code: codes[0] ?? "" } });
    })().catch(async () => {
      if (!response.headersSent) {
        respond(response, 500, "Connection failed", "Return to the app and try connecting again.");
      }
      await finish({
        kind: "failure",
        error: new ProviderIntegrationError(
          "PROVIDER_UNAVAILABLE",
          "The local authorization callback failed.",
        ),
      });
    });
  };

  const rejectAttempt = (response: ServerResponse): void => {
    invalidAttempts += 1;
    respond(response, 400, "Invalid callback", "Return to the app and try connecting again.");
    if (invalidAttempts >= parsed.maximumInvalidAttempts) {
      void finish({
        kind: "failure",
        error: new ProviderIntegrationError(
          "CONSENT_MISMATCH",
          "Too many invalid local authorization callbacks were received.",
        ),
      });
    }
  };

  const timeout = setTimeout(() => {
    void finish({
      kind: "failure",
      error: new ProviderIntegrationError("CONSENT_EXPIRED", "The local authorization callback timed out."),
    });
  }, parsed.timeoutMs);
  timeout.unref?.();

  try {
    server = createServer(requestHandler);
    await new Promise<void>((resolvePromise, reject) => {
      const active = server;
      if (!active) return reject(new Error("Callback server was not created."));
      active.once("error", reject);
      active.listen({ host: "127.0.0.1", port: parsed.port, exclusive: true }, () => {
        active.off("error", reject);
        active.on("error", () => {
          void finish({
            kind: "failure",
            error: new ProviderIntegrationError(
              "PROVIDER_UNAVAILABLE",
              "The local authorization callback failed.",
            ),
          });
        });
        resolvePromise();
      });
    });
  } catch (error) {
    clearTimeout(timeout);
    server?.close();
    server = undefined;
    settled = true;
    callback.catch(() => undefined);
    rejectCallback(
      new ProviderIntegrationError(
        "PROVIDER_UNAVAILABLE",
        "The local authorization callback could not start.",
        error,
      ),
    );
    throw new ProviderIntegrationError(
      "PROVIDER_UNAVAILABLE",
      "The local authorization callback could not start.",
      error,
    );
  }

  return {
    redirectUri: parsed.redirectUri,
    callback,
    close: async () => {
      await finish({
        kind: "failure",
        error: new ProviderIntegrationError("CONSENT_CANCELLED", "The local authorization callback was cancelled."),
      });
    },
  };
}

interface ValidatedCallbackOptions {
  readonly redirectUri: string;
  readonly origin: string;
  readonly path: string;
  readonly port: number;
  readonly expectedState: string;
  readonly timeoutMs: number;
  readonly maximumInvalidAttempts: number;
}

function validateOptions(options: LoopbackOAuthCallbackOptions): ValidatedCallbackOptions {
  let url: URL;
  try {
    url = new URL(options.redirectUri);
  } catch (error) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The OAuth callback URI is invalid.", error);
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65535 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new ProviderIntegrationError(
      "INVALID_CONFIGURATION",
      "The OAuth callback must use an explicit IPv4 loopback address and non-privileged port.",
    );
  }
  if (
    options.expectedState.length < 32 ||
    options.expectedState.length > 512 ||
    !/^[A-Za-z0-9_-]+$/u.test(options.expectedState)
  ) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The expected OAuth state is invalid.");
  }
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const maximumInvalidAttempts = options.maximumInvalidAttempts ?? 5;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30 * 60 * 1000) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The OAuth callback timeout is invalid.");
  }
  if (!Number.isSafeInteger(maximumInvalidAttempts) || maximumInvalidAttempts < 1 || maximumInvalidAttempts > 20) {
    throw new ProviderIntegrationError("INVALID_CONFIGURATION", "The OAuth callback attempt limit is invalid.");
  }
  return {
    redirectUri: url.toString(),
    origin: url.origin,
    path: url.pathname,
    port,
    expectedState: options.expectedState,
    timeoutMs,
    maximumInvalidAttempts,
  };
}

function isLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

function hasExpectedHost(request: IncomingMessage, port: number): boolean {
  return request.headers.host?.toLowerCase() === `127.0.0.1:${port}`;
}

function isSafeCode(value: string): boolean {
  return value.length >= 1 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isSafeOAuthError(value: string): boolean {
  return /^[A-Za-z0-9._~-]{1,128}$/u.test(value);
}

function constantTimeTextEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  try {
    return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
  } finally {
    expectedBytes.fill(0);
    actualBytes.fill(0);
  }
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function respond(response: ServerResponse, status: number, title: string, message: string): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`,
  );
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
