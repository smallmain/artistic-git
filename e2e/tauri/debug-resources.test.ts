// @vitest-environment node

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { installDebugGitDist } from "./debug-resources";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("installDebugGitDist", () => {
  it("replaces stale no-bundle resources with the verified active tree", () => {
    const root = fixtureRoot();
    const source = path.join(root, "source");
    const binary = path.join(root, "target", "debug", "artistic-git-shell");
    const destination = path.join(path.dirname(binary), "git-dist");
    mkdirSync(path.join(source, "git", "bin"), { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(source, "manifest.json"), "verified\n");
    writeFileSync(path.join(source, "git", "bin", "git"), "binary\n");
    writeFileSync(path.join(destination, "stale"), "stale\n");

    expect(installDebugGitDist(source, binary)).toBe(destination);
    expect(readFileSync(path.join(destination, "manifest.json"), "utf8")).toBe(
      "verified\n",
    );
    expect(
      readFileSync(path.join(destination, "git", "bin", "git"), "utf8"),
    ).toBe("binary\n");
    expect(existsSync(path.join(destination, "stale"))).toBe(false);
  });

  it("keeps the previous debug resources when the active manifest is missing", () => {
    const root = fixtureRoot();
    const source = path.join(root, "source");
    const binary = path.join(root, "target", "debug", "artistic-git-shell");
    const destination = path.join(path.dirname(binary), "git-dist");
    mkdirSync(source, { recursive: true });
    mkdirSync(destination, { recursive: true });
    writeFileSync(path.join(destination, "manifest.json"), "previous\n");

    expect(() => installDebugGitDist(source, binary)).toThrow(
      /manifest is missing/,
    );
    expect(readFileSync(path.join(destination, "manifest.json"), "utf8")).toBe(
      "previous\n",
    );
  });

  it("recovers the previous tree after an interrupted directory exchange", () => {
    const root = fixtureRoot();
    const source = path.join(root, "source");
    const binary = path.join(root, "target", "debug", "artistic-git-shell");
    const destination = path.join(path.dirname(binary), "git-dist");
    const backup = `${destination}.backup`;
    const staging = `${destination}.staging`;
    mkdirSync(source, { recursive: true });
    mkdirSync(backup, { recursive: true });
    mkdirSync(staging, { recursive: true });
    writeFileSync(path.join(backup, "manifest.json"), "previous\n");
    writeFileSync(path.join(staging, "partial"), "partial\n");

    expect(() => installDebugGitDist(source, binary)).toThrow(
      /manifest is missing/,
    );
    expect(readFileSync(path.join(destination, "manifest.json"), "utf8")).toBe(
      "previous\n",
    );
    expect(existsSync(backup)).toBe(false);
    expect(existsSync(staging)).toBe(false);
  });

  it("cleans a committed backup before installing the next active tree", () => {
    const root = fixtureRoot();
    const source = path.join(root, "source");
    const binary = path.join(root, "target", "debug", "artistic-git-shell");
    const destination = path.join(path.dirname(binary), "git-dist");
    const backup = `${destination}.backup`;
    mkdirSync(source, { recursive: true });
    mkdirSync(destination, { recursive: true });
    mkdirSync(backup, { recursive: true });
    writeFileSync(path.join(source, "manifest.json"), "next\n");
    writeFileSync(path.join(destination, "manifest.json"), "active\n");
    writeFileSync(path.join(backup, "manifest.json"), "previous\n");

    expect(installDebugGitDist(source, binary)).toBe(destination);
    expect(readFileSync(path.join(destination, "manifest.json"), "utf8")).toBe(
      "next\n",
    );
    expect(existsSync(backup)).toBe(false);
  });
});

function fixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "artistic-git-e2e-resources-"));
  roots.push(root);
  return root;
}
