import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type BuildChannel = "production" | "unsigned-alpha";

/** Build metadata is generated into dist and packaged with the main process.
 * Missing, unreadable, or malformed metadata always resolves to production. */
export function readBuildChannel(filePath = resolve(__dirname, "build-channel.json")): BuildChannel {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "channel" in parsed &&
      parsed.channel === "unsigned-alpha"
    ) {
      return "unsigned-alpha";
    }
  } catch {
    // Fail closed when build metadata is unavailable or cannot be trusted.
  }
  return "production";
}

export function canControlScreenshotProtection(options: {
  environment: "development" | "production" | "test";
  packaged: boolean;
  buildChannel: BuildChannel;
}): boolean {
  return options.packaged
    ? options.buildChannel === "unsigned-alpha"
    : options.environment !== "production";
}
