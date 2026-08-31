import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const excludedDirectories = new Set([".git", "node_modules", "dist", "release", "coverage", "work", "outputs"]);
const forbiddenNames = [
  /^\.env(?:\..+)?$/iu,
  /^credentials\.json$/iu,
  /^client_secret.*\.json$/iu,
  /^token\.json$/iu,
  /^oauth\.json$/iu
];
const forbiddenExtensions = new Set([".p8", ".p12", ".pem", ".pfx", ".key", ".der", ".cer", ".crt"]);
const contentPatterns = [
  /gh[pousr]_[A-Za-z0-9_]{20,}/u,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u
];
const failures = [];

await visit(root);

if (failures.length > 0) {
  process.stderr.write(`Repository secret hygiene check failed:\n${failures.map((item) => `- ${item}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Repository secret hygiene check passed.\n");
}

async function visit(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && excludedDirectories.has(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (!entry.isFile()) continue;
    await inspect(path);
  }
}

async function inspect(path) {
  const displayPath = relative(root, path);
  const name = basename(path);
  if (name !== ".env.example" && forbiddenNames.some((pattern) => pattern.test(name))) {
    failures.push(`${displayPath}: forbidden local environment/credential filename`);
  }
  if (forbiddenExtensions.has(extname(name).toLowerCase())) {
    failures.push(`${displayPath}: forbidden credential/key/certificate extension`);
  }

  const details = await stat(path);
  if (details.size > 5_000_000) return;
  const content = await readFile(path, "utf8").catch(() => undefined);
  if (content === undefined || content.includes("\u0000")) return;
  if (contentPatterns.some((pattern) => pattern.test(content))) {
    failures.push(`${displayPath}: content matches a credential/private-key signature`);
  }
}
