import { describe, expect, it } from "vitest";
import { describePermissions, validateManifest } from "./index.js";

const sample = {
  id: "com.acme.videostudio",
  name: "VideoStudio",
  version: "1.0.0",
  type: "server",
  description: "Turn a script into a short product video.",
  category: "video",
  entry: { mcp: "https://api.acme.com/mcp", web: "https://videostudio.acme.com" },
  compatibility: { hosts: ["claude", "chatgpt", "cursor", "claude-code", "web"] },
  permissions: { network: ["https://api.acme.com"], files: [], userData: ["email"] },
  pricing: [
    { kind: "free", includedUnits: 3, unit: "render" },
    { kind: "metered", unit: "render", displayPrice: "€0.50" },
  ],
};

describe("manifest", () => {
  it("accepts the spec example", () => {
    const r = validateManifest(sample);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
  it("rejects bad ids, missing entry, undeclared network origin", () => {
    expect(validateManifest({ ...sample, id: "videostudio" }).ok).toBe(false);
    expect(validateManifest({ ...sample, entry: {} }).errors.some((e) => e.path === "entry.mcp")).toBe(true);
    expect(validateManifest({ ...sample, permissions: { network: [] } }).errors.some((e) => e.path === "permissions.network")).toBe(true);
    expect(validateManifest({ ...sample, entry: { mcp: "http://evil.com/mcp" } }).ok).toBe(false);
  });
  it("prompt apps cannot run code", () => {
    const r = validateManifest({ ...sample, type: "prompt", entry: { mcp: "https://api.acme.com/mcp" } });
    expect(r.ok).toBe(false);
  });
  it("describes permissions", () => {
    expect(describePermissions(validateManifest(sample).manifest!)).toEqual(["Connect to https://api.acme.com", "Read your email"]);
  });
});
