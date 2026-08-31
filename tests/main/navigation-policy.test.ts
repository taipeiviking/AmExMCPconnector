import { describe, expect, it } from "vitest";
import { isRendererWindowOpenAllowed } from "../../src/main/navigation-policy";

describe("renderer navigation policy", () => {
  it("denies every renderer-selected external destination", () => {
    expect(isRendererWindowOpenAllowed("https://platform.openai.com/?data=financial-secret")).toBe(false);
    expect(isRendererWindowOpenAllowed("https://developers.openai.com/api/docs/guides/secure-mcp-tunnels")).toBe(false);
    expect(isRendererWindowOpenAllowed("file:///C:/Users/owner/private.txt")).toBe(false);
  });
});
