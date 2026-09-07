import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { z } from "zod";

export type PlaidEnvironment = "sandbox" | "production";

export interface PlaidProviderSettings {
  readonly provider: "plaid";
  readonly environment: PlaidEnvironment;
  readonly redirectUri?: string;
}

const plaidRedirectUri = z.string().trim().url().superRefine((value, context) => {
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    context.addIssue({
      code: "custom",
      message: "Plaid production redirect URI must be a plain HTTPS URL without credentials, query, or fragment."
    });
  }
});

const settingsSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.literal("plaid"),
  environment: z.enum(["sandbox", "production"]),
  redirectUri: plaidRedirectUri.optional()
}).strict();

const FILE_NAME = "provider-settings.json";

/**
 * Reads the non-secret provider choice stored under the app-owned data folder.
 * Provider credentials and account data are deliberately never stored here.
 */
export async function readPlaidProviderSettings(
  dataDirectory: string,
  fallbackEnvironment: PlaidEnvironment,
  fallbackRedirectUri?: string
): Promise<PlaidProviderSettings> {
  const path = providerSettingsPath(dataDirectory);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return {
        provider: "plaid",
        environment: fallbackEnvironment,
        ...(fallbackRedirectUri === undefined ? {} : { redirectUri: plaidRedirectUri.parse(fallbackRedirectUri) })
      };
    }
    throw new Error("The local U.S. provider setting could not be read.");
  }
  try {
    const parsed = settingsSchema.parse(JSON.parse(text));
    return {
      provider: parsed.provider,
      environment: parsed.environment,
      ...(parsed.redirectUri === undefined ? {} : { redirectUri: parsed.redirectUri })
    };
  } catch {
    throw new Error("The local U.S. provider setting is invalid. Re-save it from the guided setup.");
  }
}

/** Saves only a provider name and environment; it must never receive a secret. */
export async function writePlaidProviderSettings(
  dataDirectory: string,
  environment: PlaidEnvironment,
  redirectUri?: string
): Promise<void> {
  const path = providerSettingsPath(dataDirectory);
  await mkdir(dirname(path), { recursive: true });
  const settings = settingsSchema.parse({
    schemaVersion: 1,
    provider: "plaid",
    environment,
    ...(redirectUri === undefined || redirectUri.trim().length === 0 ? {} : { redirectUri: redirectUri.trim() })
  });
  const contents = `${JSON.stringify(settings, null, 2)}\n`;
  await writeFile(path, contents, { encoding: "utf8", flag: "w", mode: 0o600 });
}

export function providerSettingsPath(dataDirectory: string): string {
  const root = resolve(dataDirectory);
  const path = resolve(root, FILE_NAME);
  const child = relative(root, path);
  if (child.length === 0 || child === ".." || child.startsWith(`..${sep}`)) {
    throw new Error("The U.S. provider setting must remain inside the app data folder.");
  }
  return path;
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
