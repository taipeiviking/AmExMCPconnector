import { describe, expect, it } from "vitest";

import { createDemoCore, createEmptyCore } from "../../src/core";

describe("core bootstrap modes", () => {
  it("keeps production empty unless demo mode is explicitly invoked", async () => {
    const empty = createEmptyCore();
    await expect(empty.store.listAccounts()).resolves.toEqual([]);

    const demo = createDemoCore();
    await expect(demo.store.listAccounts()).resolves.toHaveLength(4);
  });
});
