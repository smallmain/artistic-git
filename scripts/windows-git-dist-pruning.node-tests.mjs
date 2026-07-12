import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assembleGitDistBase,
  pruneWindowsGitDist,
  sourceStagingDirectory,
  WINDOWS_MINGIT_GCM_RUNTIME_FILES,
  WINDOWS_MINGIT_REQUIRED_FILES,
  WINDOWS_OPENSSH_REQUIRED_CLIENT_FILES,
  WINDOWS_OPENSSH_SERVER_FILES,
} from "./git-dist-lib.mjs";

const expectedMinGitGcmRuntimeFiles = [
  "mingw64/bin/Atlassian.Bitbucket.dll",
  "mingw64/bin/Avalonia.Base.dll",
  "mingw64/bin/Avalonia.Controls.dll",
  "mingw64/bin/Avalonia.DesignerSupport.dll",
  "mingw64/bin/Avalonia.Dialogs.dll",
  "mingw64/bin/Avalonia.Markup.Xaml.dll",
  "mingw64/bin/Avalonia.Markup.dll",
  "mingw64/bin/Avalonia.Metal.dll",
  "mingw64/bin/Avalonia.MicroCom.dll",
  "mingw64/bin/Avalonia.OpenGL.dll",
  "mingw64/bin/Avalonia.Remote.Protocol.dll",
  "mingw64/bin/Avalonia.Skia.dll",
  "mingw64/bin/Avalonia.Themes.Fluent.dll",
  "mingw64/bin/Avalonia.Vulkan.dll",
  "mingw64/bin/Avalonia.Win32.dll",
  "mingw64/bin/Avalonia.dll",
  "mingw64/bin/GitHub.dll",
  "mingw64/bin/GitLab.dll",
  "mingw64/bin/HarfBuzzSharp.dll",
  "mingw64/bin/MicroCom.Runtime.dll",
  "mingw64/bin/Microsoft.AzureRepos.dll",
  "mingw64/bin/Microsoft.Bcl.AsyncInterfaces.dll",
  "mingw64/bin/Microsoft.Identity.Client.Broker.dll",
  "mingw64/bin/Microsoft.Identity.Client.Extensions.Msal.dll",
  "mingw64/bin/Microsoft.Identity.Client.NativeInterop.dll",
  "mingw64/bin/Microsoft.Identity.Client.dll",
  "mingw64/bin/Microsoft.IdentityModel.Abstractions.dll",
  "mingw64/bin/SkiaSharp.dll",
  "mingw64/bin/System.Buffers.dll",
  "mingw64/bin/System.CommandLine.dll",
  "mingw64/bin/System.ComponentModel.Annotations.dll",
  "mingw64/bin/System.Diagnostics.DiagnosticSource.dll",
  "mingw64/bin/System.IO.FileSystem.AccessControl.dll",
  "mingw64/bin/System.Memory.dll",
  "mingw64/bin/System.Numerics.Vectors.dll",
  "mingw64/bin/System.Runtime.CompilerServices.Unsafe.dll",
  "mingw64/bin/System.Security.AccessControl.dll",
  "mingw64/bin/System.Security.Cryptography.ProtectedData.dll",
  "mingw64/bin/System.Security.Principal.Windows.dll",
  "mingw64/bin/System.Text.Encodings.Web.dll",
  "mingw64/bin/System.Text.Json.dll",
  "mingw64/bin/System.Threading.Tasks.Extensions.dll",
  "mingw64/bin/System.ValueTuple.dll",
  "mingw64/bin/av_libglesv2.dll",
  "mingw64/bin/gcmcore.dll",
  "mingw64/bin/git-credential-helper-selector.exe",
  "mingw64/bin/git-credential-manager.exe",
  "mingw64/bin/git-credential-manager.exe.config",
  "mingw64/bin/libHarfBuzzSharp.dll",
  "mingw64/bin/libSkiaSharp.dll",
  "mingw64/bin/msalruntime.dll",
];

const expectedMinGitRequiredFiles = [
  "LICENSE.txt",
  "mingw64/bin/git-askpass.exe",
  "mingw64/bin/git-remote-https.exe",
  "mingw64/bin/git.exe",
  "mingw64/doc/git-credential-manager/LICENSE",
  "mingw64/doc/git-credential-manager/NOTICE",
  "mingw64/doc/git-credential-manager/README.md",
  "usr/bin/ssh-add.exe",
  "usr/bin/ssh-agent.exe",
  "usr/bin/ssh.exe",
  "usr/lib/ssh/ssh-pkcs11-helper.exe",
  "usr/lib/ssh/ssh-sk-helper.exe",
  "usr/share/licenses/openssh/LICENCE",
];

const expectedOpenSshServerFiles = [
  "FixHostFilePermissions.ps1",
  "install-sshd.ps1",
  "moduli",
  "openssh-events.man",
  "sftp-server.exe",
  "ssh-shellhost.exe",
  "sshd-auth.exe",
  "sshd-session.exe",
  "sshd.exe",
  "sshd_config_default",
  "uninstall-sshd.ps1",
];

const expectedOpenSshRequiredClientFiles = [
  "FixUserFilePermissions.ps1",
  "LICENSE.txt",
  "NOTICE.txt",
  "OpenSSHUtils.psd1",
  "OpenSSHUtils.psm1",
  "_manifest/spdx_2.2/ESRPClientLogs1022194139642.json",
  "_manifest/spdx_2.2/bsi.cose",
  "_manifest/spdx_2.2/bsi.json",
  "_manifest/spdx_2.2/manifest.cat",
  "_manifest/spdx_2.2/manifest.spdx.cose",
  "_manifest/spdx_2.2/manifest.spdx.json",
  "_manifest/spdx_2.2/manifest.spdx.json.sha256",
  "libcrypto.dll",
  "scp.exe",
  "sftp.exe",
  "ssh-add.exe",
  "ssh-agent.exe",
  "ssh-keygen.exe",
  "ssh-keyscan.exe",
  "ssh-pkcs11-helper.exe",
  "ssh-sk-helper.exe",
  "ssh.exe",
];

const windowsLayout = {
  git: "git/",
  git_executable: "git/bin/git",
  git_executable_windows: "git/mingw64/bin/git.exe",
  git_lfs: "git-lfs/",
  git_lfs_executable: "git-lfs/git-lfs",
  git_lfs_executable_windows: "git-lfs/git-lfs.exe",
  windows_openssh: "openssh/",
  windows_ssh_executable: "openssh/ssh.exe",
  helpers: "helpers/",
  credential_helper: "helpers/artistic-git-credential-helper",
  credential_helper_windows: "helpers/artistic-git-credential-helper.exe",
  ssh_askpass: "helpers/artistic-git-ssh-askpass",
  ssh_askpass_windows: "helpers/artistic-git-ssh-askpass.exe",
  manifest: "manifest.json",
};

test("Windows pruning paths remain an exact auditable contract", () => {
  assert.deepEqual(
    WINDOWS_MINGIT_GCM_RUNTIME_FILES,
    expectedMinGitGcmRuntimeFiles,
  );
  assert.deepEqual(WINDOWS_MINGIT_REQUIRED_FILES, expectedMinGitRequiredFiles);
  assert.deepEqual(WINDOWS_OPENSSH_SERVER_FILES, expectedOpenSshServerFiles);
  assert.deepEqual(
    WINDOWS_OPENSSH_REQUIRED_CLIENT_FILES,
    expectedOpenSshRequiredClientFiles,
  );
});

test("prunes only pinned GCM and Win32-OpenSSH server files and is idempotent", async () => {
  await withTempDirectory(async (root) => {
    await seedWindowsDist(root);
    await writeFixtureFile(root, "git/mingw64/bin/git-askyesno.exe");
    await writeFixtureFile(root, "git/mingw64/bin/headless-git.exe");
    await writeFixtureFile(root, "git/usr/bin/msys-crypto-3.dll");

    const first = await pruneWindowsGitDist({
      config: pruningConfig(),
      distRoot: root,
    });
    assert.deepEqual(first, {
      minGitGcm: { alreadyPruned: false, removedFiles: 51 },
      openSshServer: { alreadyPruned: false, removedFiles: 11 },
    });
    await assertFilesMissing(
      root,
      WINDOWS_MINGIT_GCM_RUNTIME_FILES.map((file) => `git/${file}`),
    );
    await assertFilesMissing(
      root,
      WINDOWS_OPENSSH_SERVER_FILES.map((file) => `openssh/${file}`),
    );
    await assertFilesPresent(
      root,
      WINDOWS_MINGIT_REQUIRED_FILES.map((file) => `git/${file}`),
    );
    await assertFilesPresent(
      root,
      WINDOWS_OPENSSH_REQUIRED_CLIENT_FILES.map((file) => `openssh/${file}`),
    );
    await assertFilesPresent(root, [
      "git/mingw64/bin/git-askyesno.exe",
      "git/mingw64/bin/headless-git.exe",
      "git/usr/bin/msys-crypto-3.dll",
      "git/usr/bin/ssh.exe",
      "git/usr/lib/ssh/ssh-pkcs11-helper.exe",
      "git/usr/lib/ssh/ssh-sk-helper.exe",
    ]);

    const second = await pruneWindowsGitDist({
      config: pruningConfig(),
      distRoot: root,
    });
    assert.deepEqual(second, {
      minGitGcm: { alreadyPruned: true, removedFiles: 0 },
      openSshServer: { alreadyPruned: true, removedFiles: 0 },
    });
  });
});

test("fails closed before deleting when one expected GCM file is missing", async () => {
  await withTempDirectory(async (root) => {
    await seedWindowsDist(root);
    await rm(path.join(root, "git", WINDOWS_MINGIT_GCM_RUNTIME_FILES[0]));

    await assert.rejects(
      pruneWindowsGitDist({ config: pruningConfig(), distRoot: root }),
      (error) => {
        assert.match(error.message, /GCM 2\.8\.0 runtime is partially present/);
        assert.match(error.details.join("\n"), /Atlassian\.Bitbucket\.dll/);
        return true;
      },
    );
    await assertFilesPresent(root, [
      `git/${WINDOWS_MINGIT_GCM_RUNTIME_FILES[1]}`,
      "openssh/sshd.exe",
    ]);
  });
});

test("preflights the exact OpenSSH inventory before deleting GCM", async () => {
  await withTempDirectory(async (root) => {
    await seedWindowsDist(root);
    await rm(path.join(root, "openssh", "sshd-session.exe"));

    await assert.rejects(
      pruneWindowsGitDist({ config: pruningConfig(), distRoot: root }),
      (error) => {
        assert.match(
          error.message,
          /OpenSSH archive inventory is not recognized/,
        );
        assert.match(error.details.join("\n"), /sshd-session\.exe/);
        return true;
      },
    );
    await assertFilesPresent(root, [
      "git/mingw64/bin/git-credential-manager.exe",
      "openssh/sshd.exe",
    ]);
  });
});

test("rejects unexpected files in the fixed Win32-OpenSSH archive", async () => {
  await withTempDirectory(async (root) => {
    await seedWindowsDist(root);
    await writeFixtureFile(root, "openssh/new-server-tool.exe");

    await assert.rejects(
      pruneWindowsGitDist({ config: pruningConfig(), distRoot: root }),
      (error) => {
        assert.match(
          error.message,
          /OpenSSH archive inventory is not recognized/,
        );
        assert.match(error.details.join("\n"), /new-server-tool\.exe/);
        return true;
      },
    );
    await assertFilesPresent(root, [
      "git/mingw64/bin/git-credential-manager.exe",
      "openssh/new-server-tool.exe",
    ]);
  });
});

test("Windows base assembly applies pruning after all sources are staged", async () => {
  await withTempDirectory(async (root) => {
    const stagingDir = path.join(root, "staging");
    const outputDir = path.join(root, "output");
    const config = windowsAssemblyConfig();
    const gitStage = sourceStagingDirectory(
      stagingDir,
      "sources.windows.x86_64.git",
    );
    const lfsStage = sourceStagingDirectory(
      stagingDir,
      "sources.windows.x86_64.git_lfs",
    );
    const openSshStage = sourceStagingDirectory(
      stagingDir,
      "sources.windows.x86_64.win32_openssh",
    );
    await seedMinGit(gitStage);
    await writeFixtureFile(lfsStage, "git-lfs.exe");
    await seedOpenSsh(openSshStage);

    await assembleGitDistBase({
      config,
      targetName: "windows-x86_64",
      stagingDir,
      outputDir,
    });

    await assertFilesMissing(outputDir, [
      "git/mingw64/bin/git-credential-manager.exe",
      "git/mingw64/bin/libSkiaSharp.dll",
      "openssh/sshd.exe",
      "openssh/sftp-server.exe",
    ]);
    await assertFilesPresent(outputDir, [
      "git/mingw64/bin/git.exe",
      "git/usr/bin/ssh.exe",
      "git/usr/lib/ssh/ssh-pkcs11-helper.exe",
      "git-lfs/git-lfs.exe",
      "openssh/LICENSE.txt",
      "openssh/_manifest/spdx_2.2/manifest.spdx.json",
      "openssh/ssh-pkcs11-helper.exe",
      "openssh/ssh-sk-helper.exe",
      "openssh/ssh.exe",
    ]);
  });
});

test("non-Windows base assembly leaves similarly named files untouched", async () => {
  await withTempDirectory(async (root) => {
    const stagingDir = path.join(root, "staging");
    const outputDir = path.join(root, "output");
    const sourceRef = "sources.linux.x86_64.git";
    const gitStage = sourceStagingDirectory(stagingDir, sourceRef);
    await writeFixtureFile(gitStage, "bin/git");
    await writeFixtureFile(gitStage, "mingw64/bin/git-credential-manager.exe");
    await writeFixtureFile(gitStage, "openssh/sshd.exe");

    await assembleGitDistBase({
      config: nonWindowsAssemblyConfig(sourceRef),
      targetName: "linux-x86_64",
      stagingDir,
      outputDir,
    });

    assert.equal(
      await readFile(
        path.join(outputDir, "git/mingw64/bin/git-credential-manager.exe"),
        "utf8",
      ),
      "mingw64/bin/git-credential-manager.exe\n",
    );
    await assertFilesPresent(outputDir, [
      "git/bin/git",
      "git/openssh/sshd.exe",
    ]);
  });
});

function pruningConfig() {
  return { resources: { layout: windowsLayout } };
}

function windowsAssemblyConfig() {
  return {
    resources: { layout: windowsLayout },
    targets: {
      "windows-x86_64": {
        platform: "windows",
        sources: [
          "sources.windows.x86_64.git",
          "sources.windows.x86_64.git_lfs",
          "sources.windows.x86_64.win32_openssh",
        ],
      },
    },
    sources: {
      windows: {
        x86_64: {
          git: { component: "git", resources_path: "git/" },
          git_lfs: { component: "git_lfs", resources_path: "git-lfs/" },
          win32_openssh: {
            component: "win32_openssh",
            resources_path: "openssh/",
          },
        },
      },
    },
  };
}

function nonWindowsAssemblyConfig(sourceRef) {
  return {
    resources: { layout: windowsLayout },
    targets: {
      "linux-x86_64": {
        platform: "linux",
        sources: [sourceRef],
      },
    },
    sources: {
      linux: {
        x86_64: {
          git: { component: "git", resources_path: "git/" },
        },
      },
    },
  };
}

async function seedWindowsDist(root) {
  await seedMinGit(path.join(root, "git"));
  await seedOpenSsh(path.join(root, "openssh"));
}

async function seedMinGit(root) {
  await writeFixtureFiles(root, [
    ...WINDOWS_MINGIT_GCM_RUNTIME_FILES,
    ...WINDOWS_MINGIT_REQUIRED_FILES,
  ]);
}

async function seedOpenSsh(root) {
  await writeFixtureFiles(root, [
    ...WINDOWS_OPENSSH_REQUIRED_CLIENT_FILES,
    ...WINDOWS_OPENSSH_SERVER_FILES,
  ]);
}

async function writeFixtureFiles(root, relativePaths) {
  for (const relativePath of relativePaths) {
    await writeFixtureFile(root, relativePath);
  }
}

async function writeFixtureFile(root, relativePath) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${relativePath}\n`);
}

async function assertFilesPresent(root, relativePaths) {
  for (const relativePath of relativePaths) {
    assert.equal(
      (await stat(path.join(root, relativePath))).isFile(),
      true,
      relativePath,
    );
  }
}

async function assertFilesMissing(root, relativePaths) {
  for (const relativePath of relativePaths) {
    await assert.rejects(
      stat(path.join(root, relativePath)),
      (error) => error.code === "ENOENT",
      relativePath,
    );
  }
}

async function withTempDirectory(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ag-win-prune-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
