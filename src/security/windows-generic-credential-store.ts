import { spawn } from "node:child_process";
import { win32 } from "node:path";
import {
  SecretReferenceError,
  type SecretReferenceStore,
} from "./secret-reference";
import { parseWindowsCredentialReference } from "./windows-generic-credential-resolver";

const REFERENCE_PREFIX = "wincred:";
const MAX_CREDENTIAL_BLOB_BYTES = 5 * 512;
const CREDENTIAL_COMMAND_TIMEOUT_MS = 10_000;

export interface WindowsCredentialMutationCommand {
  readonly operation: "write" | "delete";
  readonly executablePath: string;
  readonly powerShellSource: string;
  readonly target: string;
  readonly secret?: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface WindowsCredentialMutationResult {
  readonly exitCode: number;
}

export type WindowsCredentialMutationRunner = (
  command: WindowsCredentialMutationCommand,
) => Promise<WindowsCredentialMutationResult>;

export interface WindowsGenericCredentialStoreOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsDirectory?: string;
  readonly runner?: WindowsCredentialMutationRunner;
  readonly maxSecretBytes?: number;
}

/**
 * Creates and updates Windows Generic Credentials through CredWriteW and
 * deletes them through CredDeleteW. Secret bytes travel only over the helper's
 * stdin and are cleared from the store-owned buffer after every attempt.
 */
export class WindowsGenericCredentialStore implements SecretReferenceStore {
  private readonly platform: NodeJS.Platform;
  private readonly powershellPath: string;
  private readonly runner: WindowsCredentialMutationRunner;
  private readonly maxSecretBytes: number;

  public constructor(options: WindowsGenericCredentialStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.powershellPath = trustedPowerShellPath(
      options.windowsDirectory ?? process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows",
    );
    this.runner = options.runner ?? runCredentialMutation;
    this.maxSecretBytes = options.maxSecretBytes ?? MAX_CREDENTIAL_BLOB_BYTES;
    if (
      !Number.isSafeInteger(this.maxSecretBytes) ||
      this.maxSecretBytes < 1 ||
      this.maxSecretBytes > MAX_CREDENTIAL_BLOB_BYTES
    ) {
      throw new SecretReferenceError(
        "INVALID_REFERENCE",
        `The Windows credential write limit must be between 1 and ${MAX_CREDENTIAL_BLOB_BYTES} bytes.`,
      );
    }
  }

  public supports(reference: string): boolean {
    return reference.startsWith(REFERENCE_PREFIX);
  }

  /** Creates the target when absent and replaces its blob when it already exists. */
  public async write(reference: string, secret: Uint8Array, signal?: AbortSignal): Promise<void> {
    const target = parseWindowsCredentialReference(reference);
    this.assertWindowsAvailable();
    if (!(secret instanceof Uint8Array) || secret.byteLength < 1) {
      throw new SecretReferenceError("SECRET_WRITE_FAILED", "The credential value cannot be empty.");
    }
    if (secret.byteLength > this.maxSecretBytes) {
      throw new SecretReferenceError("SECRET_TOO_LARGE", "The credential value has an unsupported size.");
    }

    const workingSecret = Uint8Array.from(secret);
    let result: WindowsCredentialMutationResult;
    try {
      result = await this.runner({
        operation: "write",
        executablePath: this.powershellPath,
        powerShellSource: POWERSHELL_CREDENTIAL_WRITER,
        target,
        secret: workingSecret,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new SecretReferenceError(
        "SECRET_WRITE_FAILED",
        "Windows Credential Manager could not save the credential.",
      );
    } finally {
      workingSecret.fill(0);
    }
    if (result.exitCode !== 0) {
      throw new SecretReferenceError(
        "SECRET_WRITE_FAILED",
        "Windows Credential Manager could not save the credential.",
      );
    }
  }

  public async delete(reference: string, signal?: AbortSignal): Promise<boolean> {
    const target = parseWindowsCredentialReference(reference);
    this.assertWindowsAvailable();
    let result: WindowsCredentialMutationResult;
    try {
      result = await this.runner({
        operation: "delete",
        executablePath: this.powershellPath,
        powerShellSource: POWERSHELL_CREDENTIAL_DELETER,
        target,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throw new SecretReferenceError(
        "SECRET_DELETE_FAILED",
        "Windows Credential Manager could not delete the credential.",
      );
    }
    if (result.exitCode === 3) return false;
    if (result.exitCode !== 0) {
      throw new SecretReferenceError(
        "SECRET_DELETE_FAILED",
        "Windows Credential Manager could not delete the credential.",
      );
    }
    return true;
  }

  private assertWindowsAvailable(): void {
    if (this.platform !== "win32") {
      throw new SecretReferenceError(
        "PLATFORM_UNAVAILABLE",
        "Windows Generic Credential storage is available only on Windows.",
      );
    }
  }
}

/** Encodes a validated target as a non-secret reference suitable for config. */
export function formatWindowsCredentialReference(target: string): string {
  let reference: string;
  try {
    reference = `${REFERENCE_PREFIX}${encodeURIComponent(target)}`;
  } catch {
    throw new SecretReferenceError("INVALID_REFERENCE", "The Windows credential target is invalid.");
  }
  parseWindowsCredentialReference(reference);
  return reference;
}

function trustedPowerShellPath(windowsDirectory: string): string {
  if (!win32.isAbsolute(windowsDirectory) || win32.parse(windowsDirectory).root === windowsDirectory) {
    throw new SecretReferenceError("INVALID_REFERENCE", "The Windows system directory is invalid.");
  }
  const root = win32.resolve(windowsDirectory);
  const candidate = win32.normalize(
    win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  );
  const child = win32.relative(root, candidate);
  if (child.startsWith(`..${win32.sep}`) || win32.isAbsolute(child)) {
    throw new SecretReferenceError("INVALID_REFERENCE", "The Windows PowerShell path is invalid.");
  }
  return candidate;
}

async function runCredentialMutation(
  command: WindowsCredentialMutationCommand,
): Promise<WindowsCredentialMutationResult> {
  if (command.signal?.aborted) {
    throw new Error("Credential mutation cancelled.");
  }
  const encodedCommand = Buffer.from(command.powerShellSource, "utf16le").toString("base64");
  const environment = pickWindowsEnvironment(command.target);
  return await new Promise<WindowsCredentialMutationResult>((resolvePromise, reject) => {
    const child = spawn(
      command.executablePath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodedCommand],
      {
        detached: false,
        env: environment,
        shell: false,
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      },
    );
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error("Credential mutation timed out."));
    }, CREDENTIAL_COMMAND_TIMEOUT_MS);
    timeout.unref?.();
    const finish = (result: WindowsCredentialMutationResult | Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      command.signal?.removeEventListener("abort", cancel);
      if (result instanceof Error) reject(result);
      else resolvePromise(result);
    };
    const cancel = (): void => {
      child.kill("SIGKILL");
      finish(new Error("Credential mutation cancelled."));
    };

    child.once("error", () => finish(new Error("Credential mutation failed.")));
    child.stdin.once("error", () => {
      child.kill("SIGKILL");
      finish(new Error("Credential mutation failed."));
    });
    child.once("close", (code) => finish({ exitCode: code ?? -1 }));
    if (command.signal?.aborted) cancel();
    else command.signal?.addEventListener("abort", cancel, { once: true });

    if (!settled) {
      if (command.operation === "write" && command.secret !== undefined) child.stdin.end(command.secret);
      else child.stdin.end();
    }
  });
}

function pickWindowsEnvironment(target: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { AMEX_CREDENTIAL_TARGET: target };
  for (const name of ["SystemRoot", "windir", "TEMP", "TMP", "ComSpec", "PATHEXT"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

const POWERSHELL_CREDENTIAL_WRITER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AmexLocalCredentialWriter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName;
    public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob;
    public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);
}
'@
$target = [Environment]::GetEnvironmentVariable('AMEX_CREDENTIAL_TARGET', 'Process')
$memory = New-Object System.IO.MemoryStream
$bytes = $null
$blob = [IntPtr]::Zero
$exitCode = 4
try {
  [Console]::OpenStandardInput().CopyTo($memory)
  $bytes = $memory.ToArray()
  if ($bytes.Length -lt 1 -or $bytes.Length -gt 2560) { $exitCode = 4 }
  else {
    $blob = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
    [Array]::Clear($bytes, 0, $bytes.Length)
    $credential = New-Object AmexLocalCredentialWriter+CREDENTIAL
    $credential.Flags = 0
    $credential.Type = 1
    $credential.TargetName = $target
    $credential.Comment = 'Managed by Amex Local Finance Connector'
    $credential.CredentialBlobSize = $memory.Length
    $credential.CredentialBlob = $blob
    $credential.Persist = 2
    $credential.AttributeCount = 0
    $credential.Attributes = [IntPtr]::Zero
    $credential.TargetAlias = $null
    $credential.UserName = 'Amex Local Finance Connector'
    if ([AmexLocalCredentialWriter]::CredWrite([ref]$credential, 0)) { $exitCode = 0 }
  }
} finally {
  if ($bytes -ne $null) { [Array]::Clear($bytes, 0, $bytes.Length) }
  if ($blob -ne [IntPtr]::Zero) {
    $zeroes = New-Object byte[] $memory.Length
    [Runtime.InteropServices.Marshal]::Copy($zeroes, 0, $blob, $zeroes.Length)
    [Array]::Clear($zeroes, 0, $zeroes.Length)
    [Runtime.InteropServices.Marshal]::FreeHGlobal($blob)
  }
  $memory.Dispose()
}
exit $exitCode
`;

const POWERSHELL_CREDENTIAL_DELETER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AmexLocalCredentialDeleter {
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);
}
'@
$target = [Environment]::GetEnvironmentVariable('AMEX_CREDENTIAL_TARGET', 'Process')
if ([AmexLocalCredentialDeleter]::CredDelete($target, 1, 0)) { exit 0 }
if ([Runtime.InteropServices.Marshal]::GetLastWin32Error() -eq 1168) { exit 3 }
exit 4
`;
