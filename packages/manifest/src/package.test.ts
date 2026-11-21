import { describe, expect, it } from "vitest";
import { packFiles, sha256, unpackFiles } from "./package.js";

describe("aixpkg", () => {
  it("round-trips deterministically and rejects path traversal", () => {
    const files = [{ path: "aix.json", content: Buffer.from("{}") }, { path: "skills/a.md", content: Buffer.from("# A") }];
    const a = packFiles(files);
    expect(sha256(a)).toBe(sha256(packFiles([...files].reverse())));
    expect(unpackFiles(a).map((f) => f.path)).toEqual(["aix.json", "skills/a.md"]);
    expect(() => packFiles([{ path: "../etc/passwd", content: Buffer.from("") }])).toThrow();
  });
});
