import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { z } from "zod";

import type { CategoryRule } from "../core";

const MAX_RULE_FILE_BYTES = 1024 * 1024;

const categoryRuleSchema = z.object({
  id: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  priority: z.number().int().min(-1_000_000).max(1_000_000),
  match: z.object({
    kind: z.enum(["description_contains", "description_prefix", "merchant_equals"]),
    value: z.string().trim().min(1).max(256)
  }).strict(),
  categoryId: z.string().trim().min(1).max(128),
  businessPurpose: z.string().trim().min(1).max(256).optional()
}).strict();

const categoryRuleFileSchema = z.object({
  version: z.literal(1),
  rules: z.array(categoryRuleSchema).max(1000)
}).strict().superRefine((value, context) => {
  const ids = new Set<string>();
  for (const [index, rule] of value.rules.entries()) {
    if (ids.has(rule.id)) {
      context.addIssue({
        code: "custom",
        path: ["rules", index, "id"],
        message: "Category rule IDs must be unique."
      });
    }
    ids.add(rule.id);
  }
});

export interface LoadedCategoryRules {
  readonly version: 1;
  readonly rules: readonly CategoryRule[];
  readonly sourceFingerprint: string;
}

/** Reads a local owner-authored category rule file without following links or
 * accepting a file that changes during validation. The file content is never
 * copied into logs; only its SHA-256 fingerprint is retained for audit. */
export async function loadCategoryRules(filePath: string): Promise<LoadedCategoryRules> {
  const pathEntry = await lstat(filePath);
  if (!pathEntry.isFile() || pathEntry.isSymbolicLink()) {
    throw new Error("The category mapping must be a regular JSON file, not a link.");
  }
  if (pathEntry.size < 1 || pathEntry.size > MAX_RULE_FILE_BYTES) {
    throw new Error("The category mapping must contain 1 byte to 1 MiB.");
  }

  // Keep one verified file handle open for the entire read. This prevents a
  // path replacement between validation and read from silently changing the
  // rule set we fingerprint and apply.
  const handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer | undefined;
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size !== pathEntry.size ||
      before.mtimeMs !== pathEntry.mtimeMs ||
      (pathEntry.ino !== 0 && before.ino !== pathEntry.ino) ||
      (pathEntry.dev !== 0 && before.dev !== pathEntry.dev)
    ) {
      throw new Error("The category mapping changed before it could be read.");
    }
    bytes = await handle.readFile();
    const after = await handle.stat();
    if (
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino ||
      after.dev !== before.dev
    ) {
      throw new Error("The category mapping changed while it was being read.");
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("The category mapping is not valid UTF-8 JSON.");
    }
    const parsed = categoryRuleFileSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error("The category mapping does not match the version 1 rule schema.");
    }
    return {
      version: 1,
      rules: parsed.data.rules.map((rule) => structuredClone(rule)),
      sourceFingerprint: createHash("sha256").update(bytes).digest("hex")
    };
  } finally {
    bytes?.fill(0);
    await handle.close();
  }
}
