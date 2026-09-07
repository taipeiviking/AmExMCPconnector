import { spawn } from "node:child_process";
import { win32 } from "node:path";
import { SecretReferenceError, type SecretReferenceResolver } from "./secret-reference";

const REFERENCE_PREFIX = "wincred:";
const MAX_TARGET_LENGTH = 256;
const MAX_ENCODED_OUTPUT_BYTES = 1_500_000;
const CREDENTIAL_COMMAND_TIMEOUT_MS = 10_000;

export interface WindowsCredentialCommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
}

export type WindowsCredentialCommandRunner = (
  executablePath: string,
  encodedCommand: string,
  target: string,
  signal?: AbortSignal,
) => Promise<WindowsCredentialCommandResult>;

export interface WindowsGenericCredentialResolverOptions {
  readonly platform?: NodeJS.Platform;
  readonly windowsDirectory?: string;
  readonly runner?: WindowsCredentialCommandRunner;
  readonly maxSecretBytes?: number;
}

/**
 * Reads Windows Generic Credentials using CredReadW through a fixed PowerShell
 * P/Invoke helper. References use `wincred:<percent-encoded target name>`.
 * The reference is never treated as a secret and there is deliberately no
 * literal-value or process-environment fallback.
 */
export class WindowsGenericCredentialResolver implements SecretReferenceResolver {
  private readonly platform: NodeJS.Platform;
  private readonly powershellPath: string;
  private readonly runner: WindowsCredentialCommandRunner;
  private readonly maxSecretBytes: number;

  public constructor(options: WindowsGenericCredentialResolverOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.powershellPath = trustedPowerShellPath(
      options.windowsDirectory ?? process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows",
    );
    this.runner = options.runner ?? runCredentialCommand;
    this.maxSecretBytes = options.maxSecretBytes ?? 64 * 1024;
    if (!Number.isSafeInteger(this.maxSecretBytes) || this.maxSecretBytes < 1 || this.maxSecretBytes > 1024 * 1024) {
      throw new SecretReferenceError(
        "INVALID_REFERENCE",
        "The Windows credential size limit must be between 1 byte and 1 MiB.",
      );
    }
  }

  public supports(reference: string): boolean {
    return reference.startsWith(REFERENCE_PREFIX);
  }

  public async resolve(reference: string, signal?: AbortSignal): Promise<Uint8Array> {
    const target = parseWindowsCredentialReference(reference);
    if (this.platform !== "win32") {
      throw new SecretReferenceError(
        "PLATFORM_UNAVAILABLE",
        "Windows Generic Credential lookup is available only on Windows.",
      );
    }

    let result: WindowsCredentialCommandResult;
    try {
      result = signal === undefined
        ? await this.runner(this.powershellPath, POWERSHELL_CREDENTIAL_READER, target)
        : await this.runner(this.powershellPath, POWERSHELL_CREDENTIAL_READER, target, signal);
    } catch (error) {
      if (error instanceof SecretReferenceError) throw error;
      throw new SecretReferenceError(
        "RESOLVER_FAILED",
        "Windows Credential Manager could not be queried.",
        error,
      );
    }

    if (result.exitCode === 3) {
      result.stdout.fill(0);
      throw new SecretReferenceError("SECRET_NOT_FOUND", "The referenced Windows credential was not found.");
    }
    if (result.exitCode !== 0) {
      result.stdout.fill(0);
      throw new SecretReferenceError("RESOLVER_FAILED", "Windows Credential Manager could not be queried.");
    }

    const encoded = Buffer.from(result.stdout).toString("ascii").trim();
    result.stdout.fill(0);
    if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) {
      throw new SecretReferenceError("RESOLVER_FAILED", "Windows Credential Manager returned an invalid value.");
    }
    const secret = Buffer.from(encoded, "base64");
    if (secret.byteLength < 1 || secret.byteLength > this.maxSecretBytes) {
      secret.fill(0);
      throw new SecretReferenceError("SECRET_TOO_LARGE", "The referenced credential has an unsupported size.");
    }
    const resolvedSecret = Uint8Array.from(secret);
    secret.fill(0);
    return resolvedSecret;
  }
}

export function parseWindowsCredentialReference(reference: string): string {
  if (!reference.startsWith(REFERENCE_PREFIX)) {
    throw new SecretReferenceError("UNSUPPORTED_REFERENCE", "The credential reference scheme is not supported.");
  }
  const encodedTarget = reference.slice(REFERENCE_PREFIX.length);
  let target: string;
  try {
    target = decodeURIComponent(encodedTarget);
  } catch (error) {
    throw new SecretReferenceError("INVALID_REFERENCE", "The Windows credential reference is invalid.", error);
  }
  if (
    target.length < 1 ||
    target.length > MAX_TARGET_LENGTH ||
    target.trim() !== target ||
    /[\u0000-\u001f\u007f]/u.test(target)
  ) {
    throw new SecretReferenceError(
      "INVALID_REFERENCE",
      `A Windows credential target must contain 1-${MAX_TARGET_LENGTH} printable characters.`,
    );
  }
  return target;
}

function trustedPowerShellPath(windowsDirectory: string): string {
  if (!win32.isAbsolute(windowsDirectory) || win32.parse(windowsDirectory).root === windowsDirectory) {
    throw new SecretReferenceError("INVALID_REFERENCE", "The Windows system directory is invalid.");
  }
  const root = win32.resolve(windowsDirectory);
  const candidate = win32.normalize(win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  const child = win32.relative(root, candidate);
  if (child.startsWith(`..${win32.sep}`) || win32.isAbsolute(child)) {
    throw new SecretReferenceError("INVALID_REFERENCE", "The Windows PowerShell path is invalid.");
  }
  return candidate;
}

async function runCredentialCommand(
  executablePath: string,
  encodedCommand: string,
  target: string,
  signal?: AbortSignal,
): Promise<WindowsCredentialCommandResult> {
  if (signal?.aborted) {
    throw new SecretReferenceError("RESOLVER_FAILED", "Windows Credential Manager lookup was cancelled.");
  }
  const command = Buffer.from(encodedCommand, "utf16le").toString("base64");
  const environment = pickWindowsEnvironment(target);
  return await new Promise<WindowsCredentialCommandResult>((resolvePromise, reject) => {
    const child = spawn(
      executablePath,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", command],
      {
        detached: false,
        env: environment,
        shell: false,
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let exceeded = false;
    let settled = false;
    const finish = (result: WindowsCredentialCommandResult | SecretReferenceError): void => {
      if (settled) {
        if (!(result instanceof SecretReferenceError)) result.stdout.fill(0);
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      if (result instanceof SecretReferenceError) reject(result);
      else resolvePromise(result);
    };
    const cancel = (): void => {
      for (const buffered of chunks) buffered.fill(0);
      chunks.length = 0;
      child.kill("SIGKILL");
      finish(new SecretReferenceError("RESOLVER_FAILED", "Windows Credential Manager lookup was cancelled."));
    };
    const timeout = setTimeout(() => {
      for (const buffered of chunks) buffered.fill(0);
      chunks.length = 0;
      child.kill("SIGKILL");
      finish(new SecretReferenceError("RESOLVER_FAILED", "Windows Credential Manager lookup timed out."));
    }, CREDENTIAL_COMMAND_TIMEOUT_MS);
    timeout.unref?.();
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_ENCODED_OUTPUT_BYTES) {
        exceeded = true;
        for (const buffered of chunks) buffered.fill(0);
        chunks.length = 0;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    child.once("error", (error) => {
      for (const buffered of chunks) buffered.fill(0);
      chunks.length = 0;
      finish(new SecretReferenceError("RESOLVER_FAILED", "Windows Credential Manager could not be queried.", error));
    });
    child.once("close", (code) => {
      if (exceeded) {
        finish(new SecretReferenceError("SECRET_TOO_LARGE", "The referenced credential has an unsupported size."));
        return;
      }
      const stdout = Buffer.concat(chunks);
      for (const buffered of chunks) buffered.fill(0);
      chunks.length = 0;
      finish({ exitCode: code ?? -1, stdout });
    });
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

const POWERSHELL_CREDENTIAL_READER = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AmexLocalCredentialReader {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags; public UInt32 Type; public string TargetName;
    public string Comment; public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize; public IntPtr CredentialBlob;
    public UInt32 Persist; public UInt32 AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError = false)]
  public static extern void CredFree(IntPtr credential);
}
'@
$target = [Environment]::GetEnvironmentVariable('AMEX_CREDENTIAL_TARGET', 'Process')
$pointer = [IntPtr]::Zero
if (-not [AmexLocalCredentialReader]::CredRead($target, 1, 0, [ref]$pointer)) { exit 3 }
try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure(
    $pointer, [type][AmexLocalCredentialReader+CREDENTIAL])
  if ($credential.CredentialBlobSize -lt 1) { exit 4 }
  $bytes = New-Object byte[] $credential.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
  [Console]::Out.Write([Convert]::ToBase64String($bytes))
  [Array]::Clear($bytes, 0, $bytes.Length)
} finally {
  if ($pointer -ne [IntPtr]::Zero) { [AmexLocalCredentialReader]::CredFree($pointer) }
}
`;
