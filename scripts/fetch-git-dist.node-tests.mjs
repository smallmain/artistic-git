/* global URL, clearTimeout, process, setTimeout */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:https";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ensureGitTransportBuiltinWrappers,
  extractionCommand,
  normalizeGitExecutableCopies,
  stripLinuxExecutables,
  stripMacosBinary,
  writeGitExecutableAliasWrapper,
} from "./fetch-git-dist.mjs";

async function writeExecutable(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content);
  await chmod(filePath, 0o755);
}

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("extractor selection supports extensionless cached ZIP assets on every platform", () => {
  const archivePath = path.join("cache", "downloads", "sha256", "asset");
  const destination = path.join("work", "extracted output");
  const archiveName = "MinGit-2.55.0.2-64-bit.zip";

  const windows = extractionCommand(
    archivePath,
    destination,
    archiveName,
    "win32",
  );
  assert.equal(windows.executable, "powershell.exe");
  assert.deepEqual(windows.args.slice(0, 4), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
  ]);
  assert.equal(windows.args.length, 5);
  assert.match(
    windows.args[4],
    /System\.IO\.Compression\.ZipFile\]::ExtractToDirectory/,
  );
  assert.doesNotMatch(windows.args[4], /Expand-Archive/);
  assert.equal(windows.args[4].includes(archivePath), false);
  assert.equal(windows.args[4].includes(destination), false);
  assert.ok(
    windows.args[4].includes(Buffer.from(archivePath).toString("base64")),
  );
  assert.ok(
    windows.args[4].includes(Buffer.from(destination).toString("base64")),
  );

  for (const platform of ["darwin", "linux"]) {
    assert.deepEqual(
      extractionCommand(archivePath, destination, archiveName, platform),
      {
        executable: "unzip",
        args: ["-q", "-o", archivePath, "-d", destination],
      },
    );
  }
});

test("extractor selection keeps tar archives platform independent", () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    assert.deepEqual(
      extractionCommand(
        "cache/asset",
        "work/source",
        "git-2.55.0.tar.xz",
        platform,
      ),
      {
        executable: "tar",
        args: ["-xf", "cache/asset", "-C", "work/source"],
      },
    );
  }
});

test("Windows MinGit gets a visible, deterministic upload-archive dispatcher", async (t) => {
  const temporary = await mkdtemp(
    path.join(os.tmpdir(), "ag MinGit wrapper test "),
  );
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "MinGit With Spaces");
  const gitBinary = path.join(root, "mingw64", "bin", "git.exe");
  const gitExecPath = path.join(root, "mingw64", "libexec", "git-core");
  const wrapperPath = path.join(gitExecPath, "git-upload-archive");
  await writeExecutable(gitBinary, '#!/bin/sh\nprintf "<%s>\\n" "$@"\n');
  await mkdir(gitExecPath, { recursive: true });

  await ensureGitTransportBuiltinWrappers(root, { platform: "windows" });

  const expectedContent =
    '#!/bin/sh\nexec "$(dirname "$0")/../../bin/git.exe" upload-archive "$@"\n';
  assert.equal(await readFile(wrapperPath, "utf8"), expectedContent);
  assert.equal(
    await lstat(path.join(gitExecPath, "git-receive-pack")).catch(() => null),
    null,
  );
  assert.equal(
    await lstat(path.join(gitExecPath, "git-upload-pack")).catch(() => null),
    null,
  );

  const before = await stat(wrapperPath);
  await ensureGitTransportBuiltinWrappers(root, { platform: "win32" });
  const after = await stat(wrapperPath);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await readFile(wrapperPath, "utf8"), expectedContent);

  if (process.platform !== "win32") {
    const run = spawnSync(
      "git-upload-archive",
      ["remote repo with spaces.git", "HEAD", "path with spaces.txt"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_EXEC_PATH: gitExecPath,
          PATH: [gitExecPath, process.env.PATH]
            .filter(Boolean)
            .join(path.delimiter),
        },
      },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(run.stdout.trim().split("\n"), [
      "<upload-archive>",
      "<remote repo with spaces.git>",
      "<HEAD>",
      "<path with spaces.txt>",
    ]);
  }
});

test("Windows MinGit wrapper preparation refuses conflicting content", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ag-mingit-wrapper-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gitBinary = path.join(root, "mingw64", "bin", "git.exe");
  const wrapperPath = path.join(
    root,
    "mingw64",
    "libexec",
    "git-core",
    "git-upload-archive",
  );
  await writeExecutable(gitBinary, "#!/bin/sh\nexit 0\n");
  await writeExecutable(wrapperPath, "#!/bin/sh\necho existing command\n");

  await assert.rejects(
    ensureGitTransportBuiltinWrappers(root, { platform: "windows" }),
    /refusing to overwrite an existing Git builtin command with different content/,
  );
  assert.equal(
    await readFile(wrapperPath, "utf8"),
    "#!/bin/sh\necho existing command\n",
  );
});

function runCommand(command, args, { cwd, env, timeout = 15_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `${command} ${args.join(" ")} exceeded the ${timeout}ms test timeout`,
        ),
      );
    }, timeout);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timer);
      const result = {
        status,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (status !== 0) {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with ${signal ?? `exit ${status}`}: ${result.stderr || result.stdout}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, "object");
  return address.port;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function createGitInstallFixture(root) {
  const mainGit =
    '#!/bin/sh\nprintf "main:%s\\n" "$(basename "$0")"\nprintf "%s\\n" "$@"\n';
  const scalar = '#!/bin/sh\nprintf "scalar:%s\\n" "$*"\n';
  const gitShell = '#!/bin/sh\nprintf "shell:%s\\n" "$*"\n';
  const cvsserver = '#!/bin/sh\nprintf "cvs:%s\\n" "$*"\n';
  const remoteCurl = '#!/bin/sh\nprintf "%s\\n" "$(basename "$0")" "$@"\n';
  const files = new Map([
    ["git/bin/git", mainGit],
    ["git/libexec/git-core/git", mainGit],
    ["git/libexec/git-core/git-add", mainGit],
    ["git/bin/scalar", scalar],
    ["git/libexec/git-core/scalar", scalar],
    ["git/bin/git-shell", gitShell],
    ["git/libexec/git-core/git-shell", gitShell],
    ["git/bin/git-cvsserver", cvsserver],
    ["git/libexec/git-core/git-cvsserver", cvsserver],
    ["git/libexec/git-core/git-remote-http", remoteCurl],
    ["git/libexec/git-core/git-remote-ftp", remoteCurl],
    ["git/libexec/git-core/git-remote-ftps", remoteCurl],
    ["git/libexec/git-core/git-remote-https", remoteCurl],
    ["git/libexec/git-core/git-remote-custom", remoteCurl],
  ]);
  for (const [relativePath, content] of files) {
    await writeExecutable(path.join(root, relativePath), content);
  }
}

test(
  "normalizes only verified source-built Git executable copies",
  { skip: process.platform === "win32" },
  async (t) => {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "ag-git-alias-test-"),
    );
    t.after(() => rm(temporary, { recursive: true, force: true }));
    const root = path.join(
      temporary,
      "Artistic Git.app",
      "Contents",
      "Resources",
      "git-dist",
    );
    await createGitInstallFixture(root);

    const result = await normalizeGitExecutableCopies(root);
    assert.deepEqual(result, {
      aliasReplacements: 7,
      builtinReplacements: 1,
    });

    const expectedAliases = [
      "git/libexec/git-core/git",
      "git/libexec/git-core/scalar",
      "git/libexec/git-core/git-shell",
      "git/bin/git-cvsserver",
      "git/libexec/git-core/git-remote-ftp",
      "git/libexec/git-core/git-remote-ftps",
      "git/libexec/git-core/git-remote-https",
    ];
    for (const relativePath of expectedAliases) {
      const filePath = path.join(root, relativePath);
      assert.equal(
        (await lstat(filePath)).isSymbolicLink(),
        false,
        relativePath,
      );
      assert.match(await readFile(filePath, "utf8"), /^#!\/bin\/sh\nexec /);
    }

    const builtin = await readFile(
      path.join(root, "git/libexec/git-core/git-add"),
      "utf8",
    );
    assert.equal(
      builtin,
      '#!/bin/sh\nexec "$(dirname "$0")/../../bin/git" add "$@"\n',
    );

    const unknownAlias = path.join(
      root,
      "git/libexec/git-core/git-remote-custom",
    );
    assert.equal(
      await readFile(unknownAlias, "utf8"),
      '#!/bin/sh\nprintf "%s\\n" "$(basename "$0")" "$@"\n',
    );

    if (process.platform !== "win32") {
      const remote = spawnSync(
        path.join(root, "git/libexec/git-core/git-remote-https"),
        ["origin", "https://example.test/repository.git"],
        { encoding: "utf8" },
      );
      assert.equal(remote.status, 0, remote.stderr);
      // The dispatcher deliberately exposes the canonical argv[0]. remote-curl
      // derives its transport from the unchanged URL argument instead.
      assert.deepEqual(remote.stdout.trim().split("\n"), [
        "git-remote-http",
        "origin",
        "https://example.test/repository.git",
      ]);

      const builtinRun = spawnSync(
        path.join(root, "git/libexec/git-core/git-add"),
        ["tracked.txt"],
        { encoding: "utf8" },
      );
      assert.equal(builtinRun.status, 0, builtinRun.stderr);
      assert.deepEqual(builtinRun.stdout.trim().split("\n"), [
        "main:git",
        "add",
        "tracked.txt",
      ]);
    }

    assert.deepEqual(await normalizeGitExecutableCopies(root), {
      aliasReplacements: 0,
      builtinReplacements: 0,
    });
  },
);

test(
  "does not replace a known alias whose content differs",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ag-git-alias-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await createGitInstallFixture(root);
    const alias = path.join(root, "git/libexec/git-core/scalar");
    await writeExecutable(
      alias,
      "#!/bin/sh\necho independently-built-scalar\n",
    );

    const result = await normalizeGitExecutableCopies(root);
    assert.equal(result.aliasReplacements, 6);
    assert.equal(
      await readFile(alias, "utf8"),
      "#!/bin/sh\necho independently-built-scalar\n",
    );
  },
);

test("alias wrapper rejects paths outside the install root before mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ag-git-alias-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installRoot = path.join(root, "install");
  const canonical = path.join(installRoot, "git/bin/git");
  const outsideAlias = path.join(root, "outside-alias");
  const outsideCanonical = path.join(root, "outside-git");
  await writeExecutable(canonical, "canonical\n");
  await writeExecutable(outsideAlias, "alias\n");
  await writeExecutable(outsideCanonical, "outside\n");

  await assert.rejects(
    writeGitExecutableAliasWrapper({
      aliasPath: outsideAlias,
      canonicalPath: canonical,
      installRoot,
    }),
    /Git executable alias must stay inside/,
  );
  assert.equal(await readFile(outsideAlias, "utf8"), "alias\n");

  const insideAlias = path.join(installRoot, "git/libexec/git-core/git");
  await writeExecutable(insideAlias, "alias\n");
  await assert.rejects(
    writeGitExecutableAliasWrapper({
      aliasPath: insideAlias,
      canonicalPath: outsideCanonical,
      installRoot,
    }),
    /canonical Git executable must stay inside/,
  );
  assert.equal(await readFile(insideAlias, "utf8"), "alias\n");
});

test("macOS stripping removes only debug and local symbols", async () => {
  const calls = [];
  await stripMacosBinary("/tmp/universal-git", {
    commandRunner: async (...args) => calls.push(args),
  });
  assert.deepEqual(calls, [
    [
      "strip",
      ["-S", "-x", "/tmp/universal-git"],
      { label: "strip /tmp/universal-git" },
    ],
  ]);
});

test(
  "Linux stripping visits every executable regular ELF file",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ag-strip-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const executable = path.join(root, "git");
    const hardlink = path.join(root, "git-add");
    const nonExecutable = path.join(root, "git-data");
    const script = path.join(root, "git-script");
    const elfFixture = Buffer.concat([
      Buffer.from("7f454c46", "hex"),
      Buffer.alloc(64),
    ]);
    await writeExecutable(executable, elfFixture);
    await link(executable, hardlink);
    await writeFile(nonExecutable, elfFixture);
    await writeExecutable(script, "#!/bin/sh\nexit 0\n");
    const calls = [];

    const stripped = await stripLinuxExecutables(root, {
      commandRunner: async (...args) => calls.push(args),
    });

    assert.equal(stripped, 2);
    assert.deepEqual(
      calls,
      [executable, hardlink].map((filePath) => [
        "strip",
        ["--strip-unneeded", filePath],
        { label: `strip ${filePath}` },
      ]),
    );
  },
);

test(
  "embedded git-remote-https clones from a local TLS dumb HTTP repository",
  { skip: process.platform === "win32", timeout: 30_000 },
  async (t) => {
    const target =
      process.platform === "darwin" ? "macos-universal" : "linux-x86_64";
    const distRoot = path.join(repoRoot, "src-tauri", "resources", "git-dist");
    const manifestPath = path.join(distRoot, "manifest.json");
    const manifest = await readFile(manifestPath, "utf8")
      .then(JSON.parse)
      .catch(() => null);
    assert.ok(
      manifest,
      `embedded toolchain is missing; run pnpm git-toolchain:ensure -- --target=${target}`,
    );
    assert.equal(
      manifest.target,
      target,
      `embedded toolchain target is ${manifest.target}; run pnpm git-toolchain:ensure -- --target=${target}`,
    );

    const gitExecutable = path.join(distRoot, manifest.paths.gitExecutable);
    const gitExecPath = path.join(distRoot, "git", "libexec", "git-core");
    const httpsHelper = path.join(gitExecPath, "git-remote-https");
    for (const required of [gitExecutable, httpsHelper]) {
      assert.equal(
        (await stat(required).catch(() => null))?.isFile(),
        true,
        `embedded toolchain is incomplete at ${required}; run pnpm git-toolchain:ensure -- --target=${target}`,
      );
    }

    const root = await mkdtemp(path.join(os.tmpdir(), "ag-https-smoke-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const home = path.join(root, "home");
    const source = path.join(root, "source");
    const servedRoot = path.join(root, "served");
    const bare = path.join(servedRoot, "repo.git");
    const clone = path.join(root, "clone");
    const keyPath = path.join(root, "tls-key.pem");
    const certificatePath = path.join(root, "tls-certificate.pem");
    await mkdir(home);
    await mkdir(servedRoot);

    const gitEnv = {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_EXEC_PATH: gitExecPath,
      GIT_SSL_NO_VERIFY: "1",
      GIT_TERMINAL_PROMPT: "0",
      HOME: home,
    };
    await runCommand(gitExecutable, ["init", "-b", "main", source], {
      env: gitEnv,
    });
    await writeFile(path.join(source, "transport.txt"), "embedded https\n");
    await runCommand(gitExecutable, ["config", "user.name", "HTTPS Smoke"], {
      cwd: source,
      env: gitEnv,
    });
    await runCommand(
      gitExecutable,
      ["config", "user.email", "https-smoke@example.test"],
      { cwd: source, env: gitEnv },
    );
    await runCommand(gitExecutable, ["add", "transport.txt"], {
      cwd: source,
      env: gitEnv,
    });
    await runCommand(gitExecutable, ["commit", "-m", "HTTPS smoke"], {
      cwd: source,
      env: gitEnv,
    });
    await runCommand(gitExecutable, ["clone", "--bare", source, bare], {
      env: gitEnv,
    });
    await runCommand(gitExecutable, ["--git-dir", bare, "update-server-info"], {
      env: gitEnv,
    });
    await runCommand(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certificatePath,
        "-subj",
        "/CN=127.0.0.1",
        "-days",
        "1",
      ],
      { env: process.env },
    );

    const server = createServer(
      {
        key: await readFile(keyPath),
        cert: await readFile(certificatePath),
      },
      async (request, response) => {
        try {
          const pathname = decodeURIComponent(
            new URL(request.url, "https://127.0.0.1").pathname,
          );
          const filePath = path.resolve(servedRoot, `.${pathname}`);
          const relative = path.relative(servedRoot, filePath);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          ) {
            response.writeHead(403).end();
            return;
          }
          const content = await readFile(filePath);
          response.writeHead(200, {
            "Content-Length": content.length,
            "Content-Type": "application/octet-stream",
          });
          response.end(request.method === "HEAD" ? undefined : content);
        } catch {
          response.writeHead(404).end();
        }
      },
    );
    const port = await listen(server);
    try {
      await runCommand(
        gitExecutable,
        ["clone", `https://127.0.0.1:${port}/repo.git`, clone],
        { env: gitEnv },
      );
    } finally {
      await closeServer(server);
    }

    assert.equal(
      await readFile(path.join(clone, "transport.txt"), "utf8"),
      "embedded https\n",
    );
  },
);

test(
  "stripped macOS executable remains runnable",
  { skip: process.platform !== "darwin" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ag-strip-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = path.join(root, "fixture.c");
    const binary = path.join(root, "fixture");
    await writeFile(
      source,
      '#include <stdio.h>\nint main(void) { puts("strip-ok"); return 0; }\n',
    );
    const compile = spawnSync("clang", ["-g", source, "-o", binary], {
      encoding: "utf8",
    });
    assert.equal(compile.status, 0, compile.stderr);
    const before = (await stat(binary)).size;

    await stripMacosBinary(binary);

    const after = (await stat(binary)).size;
    assert.ok(after < before, `${after} should be smaller than ${before}`);
    const run = spawnSync(binary, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "strip-ok\n");
  },
);

test(
  "stripped Linux executable remains runnable",
  { skip: process.platform !== "linux" },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ag-strip-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = path.join(root, "fixture.c");
    const binary = path.join(root, "fixture");
    await writeFile(
      source,
      '#include <stdio.h>\nint main(void) { puts("strip-ok"); return 0; }\n',
    );
    const compile = spawnSync("cc", ["-g", source, "-o", binary], {
      encoding: "utf8",
    });
    assert.equal(compile.status, 0, compile.stderr);
    const before = (await stat(binary)).size;

    await stripLinuxExecutables(root);

    const after = (await stat(binary)).size;
    assert.ok(after < before, `${after} should be smaller than ${before}`);
    const run = spawnSync(binary, [], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "strip-ok\n");
  },
);
