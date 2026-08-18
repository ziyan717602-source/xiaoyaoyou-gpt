import { describe, expect, it } from "vitest";
import {
  canonicalHpEvolutionMask,
  hasHpEvolutionFlag,
  isCanonicalHpEvolutionMask,
} from "./hp-evolution.js";

describe("CS01D composable HP evolution masks", () => {
  it("canonicalizes combinable flags into the stable legacy order", () => {
    const mask = canonicalHpEvolutionMask(["from-jp", "immune-inavo"]);
    expect(mask).toEqual(["immune-inavo", "from-jp"]);
    expect(hasHpEvolutionFlag(mask, "from-jp")).toBe(true);
    expect(hasHpEvolutionFlag(mask, "tux-inavo")).toBe(false);
  });

  it("rejects duplicate flags and noncanonical serialized arrays", () => {
    expect(() => canonicalHpEvolutionMask(["from-jp", "from-jp"])).toThrow(
      "must not contain duplicates",
    );
    expect(isCanonicalHpEvolutionMask(["from-jp", "immune-inavo"])).toBe(false);
    expect(isCanonicalHpEvolutionMask(["immune-inavo", "from-jp"])).toBe(true);
    expect(isCanonicalHpEvolutionMask(["unknown-mask"])).toBe(false);
  });
});
