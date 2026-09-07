import { describe, expect, it, vi } from "vitest";
import { SecretReferenceError } from "../../src/security/secret-reference";
import {
  WindowsGenericCredentialStore,
  formatWindowsCredentialReference,
  type WindowsCredentialMutationCommand,
  type WindowsCredentialMutationRunner,
} from "../../src/security/windows-generic-credential-store";
import { parseWindowsCredentialReference } from "../../src/security/windows-generic-credential-resolver";

const windowsOptions = {
  platform: "win32" as const,
  windowsDirectory: "C:\\Windows",
};

describe("Windows Generic Credential store", () => {
  it("formats validated opaque references without accepting malformed targets", () => {
    const reference = formatWindowsCredentialReference("AmexLocal/Plaid/client-secret");

    expect(reference).toBe("wincred:AmexLocal%2FPlaid%2Fclient-secret");
    expect(parseWindowsCredentialReference(reference)).toBe("AmexLocal/Plaid/client-secret");
    expect(() => formatWindowsCredentialReference(" bad-target ")).toThrow(SecretReferenceError);
    expect(() => formatWindowsCredentialReference("bad\u0000target")).toThrow(/printable/u);
  });

  it("creates or updates a credential through stdin-only secret bytes and clears its working copy", async () => {
    const observedValues: Uint8Array[] = [];
    const workingCopies: Uint8Array[] = [];
    const commands: WindowsCredentialMutationCommand[] = [];
    const runner: WindowsCredentialMutationRunner = vi.fn(async (command) => {
      commands.push(command);
      workingCopies.push(command.secret!);
      observedValues.push(Uint8Array.from(command.secret!));
      return { exitCode: 0 };
    });
    const store = new WindowsGenericCredentialStore({ ...windowsOptions, runner });
    const reference = formatWindowsCredentialReference("AmexLocal/Plaid/client-id");
    const firstValue = new TextEncoder().encode("synthetic-client-id");
    const updatedValue = new TextEncoder().encode("synthetic-updated-client-id");

    await store.write(reference, firstValue);
    await store.write(reference, updatedValue);

    expect(observedValues.map((value) => new TextDecoder().decode(value))).toEqual([
      "synthetic-client-id",
      "synthetic-updated-client-id",
    ]);
    expect(firstValue).toEqual(new TextEncoder().encode("synthetic-client-id"));
    expect(updatedValue).toEqual(new TextEncoder().encode("synthetic-updated-client-id"));
    expect(workingCopies).toEqual([new Uint8Array(firstValue.length), new Uint8Array(updatedValue.length)]);
    expect(commands).toHaveLength(2);
    for (const command of commands) {
      expect(command.operation).toBe("write");
      expect(command.executablePath).toBe(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      expect(command.target).toBe("AmexLocal/Plaid/client-id");
      expect(command.powerShellSource).toContain("CredWriteW");
      expect(command.powerShellSource).not.toContain("synthetic-client-id");
      expect(command.powerShellSource).not.toContain("synthetic-updated-client-id");
    }
  });

  it("deletes a credential and treats an already-missing target as an idempotent result", async () => {
    const runner = vi
      .fn<WindowsCredentialMutationRunner>()
      .mockResolvedValueOnce({ exitCode: 0 })
      .mockResolvedValueOnce({ exitCode: 3 });
    const store = new WindowsGenericCredentialStore({ ...windowsOptions, runner });
    const reference = formatWindowsCredentialReference("AmexLocal/Plaid/client-secret");

    await expect(store.delete(reference)).resolves.toBe(true);
    await expect(store.delete(reference)).resolves.toBe(false);
    const command = runner.mock.calls[0]![0];
    expect(command.operation).toBe("delete");
    expect(command.secret).toBeUndefined();
    expect(command.powerShellSource).toContain("CredDeleteW");
  });

  it("fails closed off Windows and before invoking a runner for invalid values", async () => {
    const runner = vi.fn<WindowsCredentialMutationRunner>();
    const offWindows = new WindowsGenericCredentialStore({
      platform: "linux",
      windowsDirectory: "C:\\Windows",
      runner,
    });
    await expect(
      offWindows.write("wincred:AmexLocal%2FPlaid%2Fclient-secret", Uint8Array.of(1)),
    ).rejects.toMatchObject({ code: "PLATFORM_UNAVAILABLE" });
    await expect(
      offWindows.delete("wincred:AmexLocal%2FPlaid%2Fclient-secret"),
    ).rejects.toMatchObject({ code: "PLATFORM_UNAVAILABLE" });

    const windows = new WindowsGenericCredentialStore({ ...windowsOptions, runner, maxSecretBytes: 4 });
    await expect(windows.write("wincred:test", new Uint8Array())).rejects.toMatchObject({
      code: "SECRET_WRITE_FAILED",
    });
    await expect(windows.write("wincred:test", Uint8Array.of(1, 2, 3, 4, 5))).rejects.toMatchObject({
      code: "SECRET_TOO_LARGE",
    });
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns stable errors without reflecting secret values or runner failures", async () => {
    const secretText = "synthetic-secret-must-not-appear";
    let workingCopy: Uint8Array | undefined;
    const store = new WindowsGenericCredentialStore({
      ...windowsOptions,
      runner: async (command) => {
        workingCopy = command.secret;
        throw new Error(secretText);
      },
    });

    let failure: unknown;
    try {
      await store.write("wincred:AmexLocal%2FPlaid%2Fclient-secret", new TextEncoder().encode(secretText));
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(SecretReferenceError);
    expect(failure).toMatchObject({ code: "SECRET_WRITE_FAILED" });
    expect(String(failure)).not.toContain(secretText);
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(workingCopy).toEqual(new Uint8Array(secretText.length));
  });

  it("maps non-success helper exits to stable write and delete errors", async () => {
    const store = new WindowsGenericCredentialStore({
      ...windowsOptions,
      runner: async (command) => ({ exitCode: command.operation === "write" ? 4 : 5 }),
    });

    await expect(store.write("wincred:test", Uint8Array.of(1))).rejects.toMatchObject({
      code: "SECRET_WRITE_FAILED",
    });
    await expect(store.delete("wincred:test")).rejects.toMatchObject({
      code: "SECRET_DELETE_FAILED",
    });
  });
});
