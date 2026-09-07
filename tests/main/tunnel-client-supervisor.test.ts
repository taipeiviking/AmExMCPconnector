import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ArgumentTemplateOutboundTunnelAdapter,
  TunnelClientSupervisor,
  type OutboundTunnelClientAdapter,
} from "../../src/main/tunnel-client-supervisor";
import { verifyTunnelExecutable } from "../../src/main/tunnel-executable-verifier";

const createdDirectories: string[] = [];

afterEach(async () => {
  for (const directory of createdDirectories.splice(0)) {
    const resolvedDirectory = resolve(directory);
    const resolvedTemp = resolve(tmpdir());
    if (!resolvedDirectory.startsWith(`${resolvedTemp}\\`) && !resolvedDirectory.startsWith(`${resolvedTemp}/`)) {
      throw new Error(`Refusing to remove non-temporary test directory: ${resolvedDirectory}`);
    }
    await rm(resolvedDirectory, { recursive: true, force: true });
  }
});

describe("tunnel executable verification", () => {
  it("canonicalizes and hashes an approved regular executable", async () => {
    const directory = await temporaryDirectory();
    const executable = join(directory, "trusted-tunnel.exe");
    const bytes = Buffer.from("test executable bytes", "utf8");
    await writeFile(executable, bytes);
    const expectedSha256 = createHash("sha256").update(bytes).digest("hex");

    const canonicalExecutable = await realpath(executable);

    await expect(
      verifyTunnelExecutable(executable, {
        expectedSha256,
        allowedDirectories: [directory],
        platform: process.platform,
      }),
    ).resolves.toMatchObject({ canonicalPath: canonicalExecutable, sha256: expectedSha256, sizeBytes: bytes.length });
    await expect(
      verifyTunnelExecutable(executable, {
        expectedSha256: "0".repeat(64),
        allowedDirectories: [directory],
        platform: process.platform,
      }),
    ).rejects.toMatchObject({ code: "HASH_MISMATCH" });
  });

  it("rejects relative paths and directories", async () => {
    await expect(verifyTunnelExecutable("tunnel.exe", { platform: "win32" })).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
    const directory = await temporaryDirectory();
    const directoryNamedLikeExecutable = join(directory, "not-a-file.exe");
    await mkdir(directoryNamedLikeExecutable);
    await expect(verifyTunnelExecutable(directoryNamedLikeExecutable, { platform: process.platform })).rejects.toMatchObject({
      code: "NOT_A_FILE",
    });
  });

  it.runIf(process.platform === "win32")(
    "accepts a non-reparse Windows namespace alias and returns the canonical path",
    async () => {
      const directory = await temporaryDirectory();
      const executable = join(directory, "trusted-alias-tunnel.exe");
      const namespacedExecutable = `\\\\?\\${executable}`;
      const namespacedDirectory = `\\\\?\\${directory}`;
      const bytes = Buffer.from("namespace-alias executable bytes", "utf8");
      await writeFile(executable, bytes);
      const expectedSha256 = createHash("sha256").update(bytes).digest("hex");

      await expect(verifyTunnelExecutable(namespacedExecutable, {
        expectedSha256,
        allowedDirectories: [namespacedDirectory],
        platform: "win32",
      })).resolves.toEqual({
        canonicalPath: await realpath(executable),
        sha256: expectedSha256,
        sizeBytes: bytes.length,
      });
    },
  );

  it("rejects an executable reached through a symbolic-link or junction parent", async () => {
    const root = await temporaryDirectory();
    const targetDirectory = join(root, "canonical-target");
    const linkedDirectory = join(root, "redirected-parent");
    await mkdir(targetDirectory);
    await symlink(targetDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
    const executable = join(targetDirectory, "linked-tunnel.exe");
    await writeFile(executable, "linked executable bytes");

    await expect(verifyTunnelExecutable(join(linkedDirectory, "linked-tunnel.exe"), {
      allowedDirectories: [linkedDirectory],
      platform: process.platform,
    })).rejects.toMatchObject({ code: "REPARSE_POINT_REJECTED" });
  });

  it("rejects a canonical executable outside the approved directory", async () => {
    const approvedDirectory = await temporaryDirectory();
    const unapprovedDirectory = await temporaryDirectory();
    const executable = join(unapprovedDirectory, "unapproved-tunnel.exe");
    await writeFile(executable, "unapproved executable bytes");

    await expect(verifyTunnelExecutable(executable, {
      allowedDirectories: [approvedDirectory],
      platform: process.platform,
    })).rejects.toMatchObject({ code: "OUTSIDE_ALLOWED_DIRECTORY" });
  });
});

describe("tunnel client supervisor", () => {
  it("spawns without a shell, reports health, and stops gracefully", async () => {
    const executable = await temporaryExecutable();
    const child = new FakeChildProcess();
    const spawnCalls: Array<{ executable: string; args: readonly string[]; options: SpawnOptions }> = [];
    const spawner = (path: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
      spawnCalls.push({ executable: path, args, options });
      return child as unknown as ChildProcess;
    };
    const statusChanges: string[] = [];
    const supervisor = new TunnelClientSupervisor(
      {
        executablePath: executable,
        tunnelId: "owner-tunnel",
        profile: "amex-local",
        localMcpEndpoint: "http://127.0.0.1:43121/mcp",
        startupGraceMs: 0,
        stopTimeoutMs: 100,
        healthCheck: async () => true,
        onStatusChanged: (status) => statusChanges.push(`${status.state}:${status.health}`),
      },
      new ArgumentTemplateOutboundTunnelAdapter("vetted-client", [
        "tunnel",
        "run",
        "--profile={profile}",
        "--tunnel={tunnelId}",
        "--url={localMcpEndpoint}",
      ]),
      spawner,
    );

    await expect(supervisor.start()).resolves.toMatchObject({ state: "running", health: "healthy" });
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).toContain("--url=http://127.0.0.1:43121/mcp");
    expect(spawnCalls[0]?.options).toMatchObject({
      detached: false,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    await supervisor.stop();
    expect(supervisor.status).toEqual({ state: "stopped", health: "unknown" });
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(statusChanges).toContain("running:healthy");
  });

  it("detects an unexpected exit and never exposes raw child errors in status", async () => {
    const executable = await temporaryExecutable();
    const child = new FakeChildProcess();
    const supervisor = new TunnelClientSupervisor(
      {
        executablePath: executable,
        tunnelId: "owner-tunnel",
        profile: "amex-local",
        localMcpEndpoint: "http://127.0.0.1:43121/mcp",
        startupGraceMs: 0,
      },
      new ArgumentTemplateOutboundTunnelAdapter("vetted-client", ["--url", "{localMcpEndpoint}"]),
      () => child as unknown as ChildProcess,
    );
    await supervisor.start();

    child.exitCode = 17;
    child.emit("exit", 17, null);
    expect(supervisor.status).toEqual({
      state: "error",
      health: "unhealthy",
      lastError: "The tunnel client exited unexpectedly.",
      exitCode: 17,
    });
  });

  it("rejects public listeners, secret environment variables, and non-loopback targets", async () => {
    const executable = await temporaryExecutable();
    const unsafeAdapter: OutboundTunnelClientAdapter = {
      adapterId: "unsafe",
      createLaunchPlan: (input) => ({
        outboundOnly: true,
        arguments: ["--url", input.localMcpEndpoint, "--listen=0.0.0.0:8080"],
        environment: { API_TOKEN: "must-not-be-on-child-environment" },
      }),
    };
    const spawner = vi.fn(() => new FakeChildProcess() as unknown as ChildProcess);
    const supervisor = new TunnelClientSupervisor(
      {
        executablePath: executable,
        tunnelId: "owner-tunnel",
        profile: "amex-local",
        localMcpEndpoint: "http://127.0.0.1:43121/mcp",
        startupGraceMs: 0,
      },
      unsafeAdapter,
      spawner,
    );
    await expect(supervisor.start()).rejects.toThrow(/unsafe argument/u);
    expect(supervisor.status).toMatchObject({ state: "error", lastError: "The tunnel launch plan is invalid." });
    expect(spawner).not.toHaveBeenCalled();

    expect(
      () =>
        new TunnelClientSupervisor(
          {
            executablePath: executable,
            tunnelId: "owner-tunnel",
            profile: "amex-local",
            localMcpEndpoint: "http://0.0.0.0:43121/mcp",
          },
          unsafeAdapter,
        ),
    ).toThrow(/loopback/u);
  });

  it("rejects alternate listener flags and public-listener URL forms", async () => {
    const executable = await temporaryExecutable();
    for (const unsafeArgument of [
      "--host=127.0.0.1",
      "--bind-address=127.0.0.1",
      "--listen-address=127.0.0.1",
      "http://0.0.0.0:8080/callback",
      "http://[::]:8080/callback",
    ]) {
      const adapter: OutboundTunnelClientAdapter = {
        adapterId: "unsafe-alternate",
        createLaunchPlan: (input) => ({
          outboundOnly: true,
          arguments: ["--url", input.localMcpEndpoint, unsafeArgument],
        }),
      };
      const spawner = vi.fn(() => new FakeChildProcess() as unknown as ChildProcess);
      const supervisor = new TunnelClientSupervisor(
        {
          executablePath: executable,
          tunnelId: "owner-tunnel",
          profile: "amex-local",
          localMcpEndpoint: "http://127.0.0.1:43121/mcp",
          startupGraceMs: 0,
        },
        adapter,
        spawner,
      );
      await expect(supervisor.start()).rejects.toThrow(/unsafe argument/u);
      expect(spawner).not.toHaveBeenCalled();
    }
  });
});

class FakeChildProcess extends EventEmitter {
  public exitCode: number | null = null;
  public readonly signals: NodeJS.Signals[] = [];

  public kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.exitCode = 0;
    queueMicrotask(() => this.emit("exit", 0, signal));
    return true;
  }
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "amex-tunnel-test-"));
  createdDirectories.push(directory);
  return directory;
}

async function temporaryExecutable(): Promise<string> {
  const directory = await temporaryDirectory();
  const executable = join(directory, "tunnel-client.exe");
  await writeFile(executable, "test tunnel executable");
  return executable;
}
