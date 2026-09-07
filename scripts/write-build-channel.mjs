import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const OUTPUT_PATH = resolve("dist/main/build-channel.json");
const ALLOWED_CHANNELS = new Set(["production", "unsigned-alpha"]);
const channel = process.env.AMEX_BUILD_CHANNEL ?? "production";

if (!ALLOWED_CHANNELS.has(channel)) {
  throw new Error("AMEX_BUILD_CHANNEL must be production or unsigned-alpha.");
}

await mkdir(dirname(OUTPUT_PATH), { recursive: true });
await writeFile(OUTPUT_PATH, `${JSON.stringify({ channel })}\n`, {
  encoding: "utf8",
  flag: "w"
});
