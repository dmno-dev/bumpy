import { test, expect, describe } from "bun:test";
import { matchGlob } from "../../src/core/config.ts";

describe("matchGlob", () => {
  test("exact match", () => {
    expect(matchGlob("pkg-a", "pkg-a")).toBe(true);
    expect(matchGlob("pkg-a", "pkg-b")).toBe(false);
  });

  test("wildcard *", () => {
    expect(matchGlob("plugin-auth", "plugin-*")).toBe(true);
    expect(matchGlob("plugin-cache", "plugin-*")).toBe(true);
    expect(matchGlob("other-thing", "plugin-*")).toBe(false);
  });

  test("scoped packages with wildcard", () => {
    expect(matchGlob("@myorg/core", "@myorg/*")).toBe(true);
    expect(matchGlob("@myorg/plugin-a", "@myorg/plugin-*")).toBe(true);
    expect(matchGlob("@other/core", "@myorg/*")).toBe(false);
  });

  test("double wildcard **", () => {
    expect(matchGlob("@myorg/a/b/c", "@myorg/**")).toBe(true);
    expect(matchGlob("@myorg/core", "@myorg/**")).toBe(true);
  });
});
