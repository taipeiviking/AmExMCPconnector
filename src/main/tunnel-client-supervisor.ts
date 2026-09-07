import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import {
  verifyTunnelExecutable,
  type VerifiedTunnelExecutable,
  type VerifyTunnelExecutableOptions,
} from "./tunnel-executable-verifier";

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TUNNEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SENSITIVE_ENVIRONMENT_NAME = /(AUTH|BEARER|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/iu;
const PUBLIC_LISTEN_ARGUMENT = /(^|[=/:])(0\.0\.0\.0|\[?::\]?)(?=[:/]|$)/iu;
const LISTEN_FLAG = /^--?(address|bind|bind-address|host|hostname|listen|listen-address)(?:=|$)/iu;

export type TunnelClientState = "stopped" | "starting" | "running" | "stopping" | "error";
export type TunnelClientHealth = "unknown" | "healthy" | "unhealthy";

export interface TunnelClientStatus {
  readonly state: TunnelClientState;
  readonly health: TunnelClientHealth;
  readonly startedAt?: string;
  readonly lastCheckedAt?: string;
  readonly lastError?: string;
  readonly exitCode?: number;
}

export interface TunnelLaunchInput {
  readonly tunnelId: string;
  readonly profile: string;
  readonly localMcpEndpoint: string;
}

export interface OutboundTunnelLaunchPlan {
  /** Contract marker: adapters must configure an outbound connector, never a local listener. */
  readonly outboundOnly: true;
  readonly arguments: readonly string[];
  /** Non-secret environment only. Tunnel credentials must remain in the client's protected profile/key store. */
  readonly environment?: Readonly<Record<string, string>>;
}

export interface OutboundTunnelClientAdapter {
  readonly adapterId: string;
  createLaunchPlan(input: TunnelLaunchInput): OutboundTunnelLaunchPlan;
}

export interface TunnelClientSupervisorOptions extends TunnelLaunchInput {
  readonly executablePath: string;
  readonly executableVerification?: Omit<VerifyTunnelExecutableOptions, "platform">;
  readonly platform?: NodeJS.Platform;
  readonly startupGraceMs?: number;
  readonly stopTimeoutMs?: number;
  readonly healthCheck?: () => Promise<boolean>;
  readonly now?: () => Date;
  readonly onStatusChanged?: (status: TunnelClientStatus) => void;
}

export type TunnelProcessSpawner = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/**
 * Verifies and supervises one outbound tunnel-client process. The supervisor
 * does not accept command-line or environment secrets and never uses a shell.
 */
export class TunnelClientSupervisor {
  private statusValue: TunnelClientStatus = { state: "stopped", health: "unknown" };
  private child?: ChildProcess;
  private expectedStop = false;
  private startPromise?: Promise<TunnelClientStatus>;
  private stopPromise?: Promise<void>;
  private readonly options: ValidatedSupervisorOptions;

  public constructor(
    options: TunnelClientSupervisorOptions,
    private readonly adapter: OutboundTunnelClientAdapter,
    private readonly processSpawner: TunnelProcessSpawner = spawn,
  ) {
    this.options = validateSupervisorOptions(options);
  }

  public get status(): TunnelClientStatus {
    return { ...this.statusValue };
  }

  public async start(): Promise<TunnelClientStatus> {
    if (this.statusValue.state === "running") return this.status;
    if (this.startPromise) return await this.startPromise;
    if (this.stopPromise) await this.stopPromise;
    const pending = this.startInternal();
    this.startPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.startPromise === pending) this.startPromise = undefined;
    }
  }

  public async stop(): Promise<void> {
    if (this.stopPromise) return await this.stopPromise;
    const pending = this.stopInternal();
    this.stopPromise = pending;
    try {
      await pending;
    } finally {
      if (this.stopPromise === pending) this.stopPromise = undefined;
    }
  }

  public async checkHealth(): Promise<TunnelClientStatus> {
    if (!this.child || this.statusValue.state !== "running") return this.status;
    const checkedAt = this.options.now().toISOString();
    if (!this.options.healthCheck) {
      this.transition({ ...this.statusValue, health: "unknown", lastCheckedAt: checkedAt });
      return this.status;
    }
    try {
      const healthy = await this.options.healthCheck();
      this.transition({
        ...this.statusValue,
        health: healthy ? "healthy" : "unhealthy",
        lastCheckedAt: checkedAt,
        ...(healthy ? {} : { lastError: "The tunnel client health check failed." }),
      });
    } catch {
      this.transition({
        ...this.statusValue,
        health: "unhealthy",
        lastCheckedAt: checkedAt,
        lastError: "The tunnel client health check failed.",
      });
    }
    return this.status;
  }

  private async startInternal(): Promise<TunnelClientStatus> {
    this.expectedStop = false;
    this.transition({ state: "starting", health: "unknown" });
    let verified: VerifiedTunnelExecutable;
    try {
      verified = await verifyTunnelExecutable(this.options.executablePath, {
        ...this.options.executableVerification,
        platform: this.options.platform,
      });
    } catch (error) {
      this.transition({ state: "error", health: "unhealthy", lastError: safeError("verification", error) });
      throw error;
    }
    let launchPlan: OutboundTunnelLaunchPlan;
    try {
      launchPlan = this.adapter.createLaunchPlan({
        tunnelId: this.options.tunnelId,
        profile: this.options.profile,
        localMcpEndpoint: this.options.localMcpEndpoint,
      });
      validateLaunchPlan(launchPlan, this.options.localMcpEndpoint);
    } catch (error) {
      this.transition({ state: "error", health: "unhealthy", lastError: "The tunnel launch plan is invalid." });
      throw error;
    }

    const startupFailure = deferredNever();
    let child: ChildProcess;
    try {
      child = this.processSpawner(verified.canonicalPath, [...launchPlan.arguments], {
        detached: false,
        env: buildChildEnvironment(launchPlan.environment),
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      this.transition({ state: "error", health: "unhealthy", lastError: "The tunnel client could not start." });
      throw error;
    }
    this.child = child;
    child.once("error", (error) => {
      startupFailure.reject(error);
      this.handleUnexpectedTermination(child, undefined, "The tunnel client process failed.");
    });
    child.once("exit", (code) => {
      startupFailure.reject(new Error("Tunnel process exited during startup."));
      this.handleUnexpectedTermination(child, code, "The tunnel client exited unexpectedly.");
    });

    try {
      await Promise.race([delay(this.options.startupGraceMs), startupFailure.promise]);
      if (this.child !== child) throw new Error("Tunnel process exited during startup.");
      const startedAt = this.options.now().toISOString();
      this.transition({ state: "running", health: "unknown", startedAt });
      if (this.options.healthCheck) {
        const checked = await this.checkHealth();
        if (checked.health !== "healthy") {
          this.expectedStop = true;
          try {
            await this.terminate(child);
          } finally {
            this.expectedStop = false;
          }
          this.transition({
            state: "error",
            health: "unhealthy",
            lastError: "The tunnel client failed its startup health check.",
          });
          throw new Error("The tunnel client failed its startup health check.");
        }
      }
      return this.status;
    } catch (error) {
      if (this.child === child) await this.terminate(child);
      if (this.statusValue.state !== "error") {
        this.transition({ state: "error", health: "unhealthy", lastError: "The tunnel client could not start." });
      }
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    const child = this.child;
    if (!child) {
      this.transition({ state: "stopped", health: "unknown" });
      return;
    }
    this.expectedStop = true;
    this.transition({ ...this.statusValue, state: "stopping", health: "unknown" });
    try {
      await this.terminate(child);
      this.transition({ state: "stopped", health: "unknown" });
    } finally {
      this.expectedStop = false;
    }
  }

  private async terminate(child: ChildProcess): Promise<void> {
    if (this.child !== child) return;
    if (child.exitCode !== null) {
      this.child = undefined;
      return;
    }
    const exited = waitForExit(child);
    child.kill("SIGTERM");
    if (!(await settlesWithin(exited, this.options.stopTimeoutMs))) {
      child.kill("SIGKILL");
      if (!(await settlesWithin(exited, this.options.stopTimeoutMs))) {
        this.transition({ state: "error", health: "unhealthy", lastError: "The tunnel client did not stop." });
        throw new Error("The tunnel client did not stop.");
      }
    }
    if (this.child === child) this.child = undefined;
  }

  private handleUnexpectedTermination(child: ChildProcess, code: number | null | undefined, message: string): void {
    if (this.child !== child) return;
    this.child = undefined;
    if (this.expectedStop || this.statusValue.state === "stopping") return;
    this.transition({
      state: "error",
      health: "unhealthy",
      lastError: message,
      ...(typeof code === "number" ? { exitCode: code } : {}),
    });
  }

  private transition(status: TunnelClientStatus): void {
    this.statusValue = { ...status };
    this.options.onStatusChanged?.(this.status);
  }
}

/**
 * Configurable argument adapter for a vetted tunnel client. Templates must use
 * the local endpoint placeholder and contain no secret placeholder.
 */
export class ArgumentTemplateOutboundTunnelAdapter implements OutboundTunnelClientAdapter {
  public constructor(
    public readonly adapterId: string,
    private readonly argumentTemplates: readonly string[],
  ) {
    if (!PROFILE_PATTERN.test(adapterId) || argumentTemplates.length < 1 || argumentTemplates.length > 64) {
      throw new Error("The outbound tunnel adapter configuration is invalid.");
    }
    if (!argumentTemplates.some((argument) => argument.includes("{localMcpEndpoint}"))) {
      throw new Error("The outbound tunnel adapter must explicitly target the local MCP endpoint.");
    }
    if (argumentTemplates.some((argument) => /\{[^{}]*(secret|token|key|password)[^{}]*\}/iu.test(argument))) {
      throw new Error("Tunnel secrets cannot be placed in command-line arguments.");
    }
    if (
      argumentTemplates.some((argument) =>
        [...argument.matchAll(/\{([^{}]+)\}/gu)].some(
          (match) => !new Set(["tunnelId", "profile", "localMcpEndpoint"]).has(match[1] ?? ""),
        ),
      )
    ) {
      throw new Error("The outbound tunnel adapter contains an unknown placeholder.");
    }
  }

  public createLaunchPlan(input: TunnelLaunchInput): OutboundTunnelLaunchPlan {
    const replacements: Readonly<Record<string, string>> = {
      tunnelId: input.tunnelId,
      profile: input.profile,
      localMcpEndpoint: input.localMcpEndpoint,
    };
    return {
      outboundOnly: true,
      arguments: this.argumentTemplates.map((template) =>
        template.replace(/\{(tunnelId|profile|localMcpEndpoint)\}/gu, (_match, name: string) => replacements[name] ?? ""),
      ),
    };
  }
}

interface ValidatedSupervisorOptions {
  readonly executablePath: string;
  readonly executableVerification?: Omit<VerifyTunnelExecutableOptions, "platform">;
  readonly platform: NodeJS.Platform;
  readonly tunnelId: string;
  readonly profile: string;
  readonly localMcpEndpoint: string;
  readonly startupGraceMs: number;
  readonly stopTimeoutMs: number;
  readonly healthCheck?: () => Promise<boolean>;
  readonly now: () => Date;
  readonly onStatusChanged?: (status: TunnelClientStatus) => void;
}

function validateSupervisorOptions(options: TunnelClientSupervisorOptions): ValidatedSupervisorOptions {
  if (!TUNNEL_ID_PATTERN.test(options.tunnelId) || !PROFILE_PATTERN.test(options.profile)) {
    throw new Error("The tunnel ID or protected profile name is invalid.");
  }
  const endpoint = validateLoopbackEndpoint(options.localMcpEndpoint);
  const startupGraceMs = options.startupGraceMs ?? 500;
  const stopTimeoutMs = options.stopTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(startupGraceMs) || startupGraceMs < 0 || startupGraceMs > 30_000) {
    throw new Error("The tunnel startup grace period is invalid.");
  }
  if (!Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 100 || stopTimeoutMs > 30_000) {
    throw new Error("The tunnel stop timeout is invalid.");
  }
  return {
    executablePath: options.executablePath,
    ...(options.executableVerification === undefined
      ? {}
      : { executableVerification: options.executableVerification }),
    platform: options.platform ?? process.platform,
    tunnelId: options.tunnelId,
    profile: options.profile,
    localMcpEndpoint: endpoint,
    startupGraceMs,
    stopTimeoutMs,
    ...(options.healthCheck === undefined ? {} : { healthCheck: options.healthCheck }),
    now: options.now ?? (() => new Date()),
    ...(options.onStatusChanged === undefined ? {} : { onStatusChanged: options.onStatusChanged }),
  };
}

function validateLoopbackEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The tunnel target must be a loopback MCP URL.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error("The tunnel target must be an explicit IPv4 loopback MCP URL.");
  }
  return url.toString();
}

function validateLaunchPlan(plan: OutboundTunnelLaunchPlan, localEndpoint: string): void {
  if (plan.outboundOnly !== true || plan.arguments.length < 1 || plan.arguments.length > 64) {
    throw new Error("The outbound tunnel launch plan is invalid.");
  }
  let includesLocalEndpoint = false;
  for (const argument of plan.arguments) {
    if (
      typeof argument !== "string" ||
      argument.length > 8192 ||
      /[\u0000\r\n]/u.test(argument) ||
      LISTEN_FLAG.test(argument) ||
      PUBLIC_LISTEN_ARGUMENT.test(argument)
    ) {
      throw new Error("The outbound tunnel launch plan contains an unsafe argument.");
    }
    if (argument === localEndpoint || argument.endsWith(`=${localEndpoint}`)) includesLocalEndpoint = true;
  }
  if (!includesLocalEndpoint) {
    throw new Error("The outbound tunnel launch plan does not target the local MCP endpoint.");
  }
  for (const [name, value] of Object.entries(plan.environment ?? {})) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name) ||
      SENSITIVE_ENVIRONMENT_NAME.test(name) ||
      value.length > 8192 ||
      /[\u0000\r\n]/u.test(value)
    ) {
      throw new Error("The outbound tunnel launch environment is invalid.");
    }
    if (name.toUpperCase() === "HTTPS_PROXY") {
      const proxy = new URL(value);
      if (!new Set(["http:", "https:"]).has(proxy.protocol) || proxy.username || proxy.password) {
        throw new Error("Tunnel proxy URLs cannot embed credentials.");
      }
    }
  }
}

function buildChildEnvironment(additional: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "windir", "TEMP", "TMP", "ComSpec", "PATH", "PATHEXT"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const [name, value] of Object.entries(additional ?? {})) environment[name] = value;
  return environment;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolvePromise) => child.once("exit", () => resolvePromise()));
}

async function settlesWithin(promise: Promise<void>, milliseconds: number): Promise<boolean> {
  return await new Promise<boolean>((resolvePromise) => {
    const timeout = setTimeout(() => resolvePromise(false), milliseconds);
    promise.then(
      () => {
        clearTimeout(timeout);
        resolvePromise(true);
      },
      () => {
        clearTimeout(timeout);
        resolvePromise(true);
      },
    );
  });
}

function deferredNever(): { promise: Promise<never>; reject: (reason: unknown) => void } {
  let reject!: (reason: unknown) => void;
  const promise = new Promise<never>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

function safeError(operation: string, _error: unknown): string {
  return `The tunnel client failed ${operation}.`;
}
