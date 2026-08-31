import { cp, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const assets = [
  ["src/renderer/index.html", "dist/renderer/index.html"],
  ["src/renderer/styles.css", "dist/renderer/styles.css"],
  ["node_modules/sql.js/dist/sql-wasm.wasm", "dist/vendor/sql-wasm.wasm"]
];

for (const [source, destination] of assets) {
  const output = resolve(destination);
  await mkdir(dirname(output), { recursive: true });
  await cp(resolve(source), output);
}
