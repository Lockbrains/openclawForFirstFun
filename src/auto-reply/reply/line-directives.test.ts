import { describe, expect, it } from "vitest";
import { parseLineDirectives, hasLineDirectives } from "./line-directives.js";

describe("line-directives (LINE channel removed - stubs)", () => {
  describe("hasLineDirectives", () => {
    it("always returns false (channel removed)", () => {
      expect(hasLineDirectives("[[quick_replies: A, B, C]]")).toBe(false);
      expect(hasLineDirectives("Just regular text")).toBe(false);
    });
  });

  describe("parseLineDirectives", () => {
    it("returns payload unchanged (channel removed)", () => {
      const payload = {
        text: "Hello [[quick_replies: A, B]]",
        mediaUrl: "https://example.com/image.jpg",
      };
      const result = parseLineDirectives(payload);
      expect(result).toBe(payload);
      expect(result.text).toBe("Hello [[quick_replies: A, B]]");
    });
  });
});
