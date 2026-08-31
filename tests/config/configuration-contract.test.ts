import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ENVIRONMENT_VARIABLE_NAMES } from "../../src/config/environment";

describe("committed environment configuration contract", () => {
  it("lists every schema variable once in .env.example and documents each one", async () => {
    const template = await readFile(resolve(".env.example"), "utf8");
    const documentation = await readFile(resolve("docs/CONFIGURATION.md"), "utf8");
    const templateNames = [...template.matchAll(/^([A-Z][A-Z0-9_]*)=/gmu)].map((match) => match[1]!);
    const documentedNames = new Set(
      [...documentation.matchAll(/`((?:AMEX|OPENAI)_[A-Z0-9_]+)`/gu)].map((match) => match[1]!)
    );

    expect(new Set(templateNames).size).toBe(templateNames.length);
    expect([...templateNames].sort()).toEqual(ENVIRONMENT_VARIABLE_NAMES);
    expect(ENVIRONMENT_VARIABLE_NAMES.filter((name) => !documentedNames.has(name))).toEqual([]);
  });

  it("ignores local environment, credential, token, database, financial-file, and log artifacts", async () => {
    const ignore = await readFile(resolve(".gitignore"), "utf8");
    for (const requiredRule of [
      ".env",
      ".env.*",
      "!.env.example",
      "credentials/",
      "*token-cache*/",
      "*.db",
      "/imports/",
      "/exports/",
      "/logs/",
      "*.log"
    ]) {
      expect(ignore.split(/\r?\n/u)).toContain(requiredRule);
    }
  });
});
