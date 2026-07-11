/* global process */

import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { expectedManifestPaths, repoRoot } from "./git-dist-lib.mjs";

export async function buildGitToolchainHelpers({
  config,
  outputDir,
  rustToolchain,
  target,
  workRoot,
}) {
  const targetTriples =
    target === "macos-universal"
      ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
      : [helperTargetTriple(target)];
  runCommand(
    "rustup",
    ["toolchain", "install", rustToolchain, "--profile", "minimal"],
    {
      label: `install Rust ${rustToolchain}`,
      stdio: "inherit",
    },
  );
  for (const triple of targetTriples) {
    runCommand(
      "rustup",
      ["target", "add", "--toolchain", rustToolchain, triple],
      { label: `install Rust target ${triple}`, stdio: "inherit" },
    );
  }

  const buildRoot = path.join(
    path.resolve(workRoot),
    `helpers-${process.pid}-${Date.now()}`,
  );
  const cargoTargetDir = path.join(buildRoot, "cargo");
  const temporaryOutput = path.join(buildRoot, "bin");
  await mkdir(temporaryOutput, { recursive: true });
  try {
    for (const triple of targetTriples) {
      runCommand(
        "cargo",
        [
          `+${rustToolchain}`,
          "build",
          "--locked",
          "-p",
          "artistic-git-helpers",
          "--bins",
          "--release",
          "--target",
          triple,
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, CARGO_TARGET_DIR: cargoTargetDir },
          label: `build helper binaries for ${triple}`,
          stdio: "inherit",
        },
      );
    }

    const paths = expectedManifestPaths(config, target);
    for (const manifestPath of [paths.credentialHelper, paths.sshAskpass]) {
      const basename = path.basename(manifestPath);
      const architectureBinaries = targetTriples.map((triple) =>
        path.join(cargoTargetDir, triple, "release", basename),
      );
      const destination = path.join(temporaryOutput, basename);
      if (target === "macos-universal") {
        runCommand(
          "lipo",
          ["-create", ...architectureBinaries, "-output", destination],
          { label: `create universal ${basename}` },
        );
      } else {
        await cp(architectureBinaries[0], destination, {
          force: true,
          preserveTimestamps: true,
        });
      }
      await chmod(destination, 0o755).catch(() => {});
    }

    await atomicPublishDirectory(temporaryOutput, path.resolve(outputDir));
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }
}

function helperTargetTriple(target) {
  const triples = {
    "linux-x86_64": "x86_64-unknown-linux-gnu",
    "windows-x86_64": "x86_64-pc-windows-msvc",
  };
  const triple = triples[target];
  if (!triple) {
    throw new Error(`unsupported helper target ${target}`);
  }
  return triple;
}

function runCommand(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) {
    throw new Error(
      `${options.label ?? executable} failed to start: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${options.label ?? executable} failed: ${result.stderr || result.stdout || `exit ${result.status}`}`,
    );
  }
}

async function atomicPublishDirectory(source, destination) {
  await mkdir(path.dirname(destination), { recursive: true });
  const backup = `${destination}.backup-${process.pid}-${Date.now()}`;
  const existing = await stat(destination).catch(() => null);
  if (existing) await rename(destination, backup);
  try {
    await rename(source, destination);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    if (existing && (await stat(backup).catch(() => null))) {
      await rename(backup, destination);
    }
    throw error;
  }
}
