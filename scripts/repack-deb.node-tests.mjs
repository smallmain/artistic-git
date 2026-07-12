import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  buildRepackedDeb,
  compressTarWithXz,
  decompressDataTar,
  inspectDebMembers,
  parseArArchive,
  parseArgs,
  repackDebFile,
  runCli,
  runCommand,
  serializeArArchive,
  validateDebWithDpkg,
  xzCompressionArgs,
} from "./repack-deb.mjs";

const fakeXzMagic = Buffer.from("fixture-xz\0", "ascii");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeString(buffer, offset, width, value) {
  const encoded = Buffer.from(value, "ascii");
  assert.ok(encoded.length <= width, `${value} must fit in ${width} bytes`);
  encoded.copy(buffer, offset);
}

function tarOctal(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function buildTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? "");
    const header = Buffer.alloc(512);
    writeString(header, 0, 100, entry.name);
    writeString(header, 100, 8, tarOctal(entry.mode ?? 0o644, 8));
    writeString(header, 108, 8, tarOctal(entry.uid ?? 0, 8));
    writeString(header, 116, 8, tarOctal(entry.gid ?? 0, 8));
    writeString(header, 124, 12, tarOctal(data.length, 12));
    writeString(header, 136, 12, tarOctal(entry.mtime ?? 1_700_000_000, 12));
    header.fill(0x20, 148, 156);
    writeString(header, 156, 1, entry.type ?? "0");
    if (entry.linkName) {
      writeString(header, 157, 100, entry.linkName);
    }
    writeString(header, 257, 6, "ustar\0");
    writeString(header, 263, 2, "00");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    chunks.push(header, data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

function readTarEntries(tar) {
  const entries = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }
    const stringField = (start, width) =>
      header
        .subarray(start, start + width)
        .toString("ascii")
        .replace(/\0.*$/, "")
        .trim();
    const octalField = (start, width) =>
      Number.parseInt(stringField(start, width), 8);
    const size = octalField(124, 12);
    const dataStart = offset + 512;
    const data = Buffer.from(tar.subarray(dataStart, dataStart + size));
    entries.push({
      name: stringField(0, 100),
      mode: octalField(100, 8),
      uid: octalField(108, 8),
      gid: octalField(116, 8),
      mtime: octalField(136, 12),
      type: stringField(156, 1) || "0",
      linkName: stringField(157, 100),
      sha256: sha256(data),
    });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return entries;
}

function fixtureDataTar() {
  return buildTar([
    { name: "usr/", mode: 0o755, type: "5" },
    { name: "usr/bin/", mode: 0o755, type: "5" },
    {
      name: "usr/bin/artistic-git",
      data: "#!/bin/sh\necho fixture\n",
      mode: 0o755,
      uid: 123,
      gid: 456,
      mtime: 1_700_001_234,
    },
    {
      name: "usr/bin/ag",
      mode: 0o777,
      type: "2",
      linkName: "artistic-git",
    },
  ]);
}

function fixtureControlTar() {
  return buildTar([
    {
      name: "control",
      mode: 0o644,
      data: [
        "Package: artistic-git-fixture",
        "Version: 1.0.0",
        "Architecture: amd64",
        "Maintainer: Artistic Git Tests <tests@example.invalid>",
        "Description: Artistic Git DEB repack fixture",
        "",
      ].join("\n"),
    },
  ]);
}

function fixtureDeb({ dataTar = fixtureDataTar() } = {}) {
  return serializeArArchive([
    { name: "debian-binary", data: Buffer.from("2.0\n") },
    { name: "control.tar.gz", data: gzipSync(fixtureControlTar()) },
    { name: "data.tar.gz", data: gzipSync(dataTar) },
  ]);
}

async function fakeDecompress(member) {
  if (member.name === "data.tar.gz") {
    return decompressDataTar(member);
  }
  if (member.name === "data.tar.xz") {
    assert.ok(member.data.subarray(0, fakeXzMagic.length).equals(fakeXzMagic));
    return Buffer.from(member.data.subarray(fakeXzMagic.length));
  }
  throw new Error(`unexpected fixture compression: ${member.name}`);
}

async function fakeCompress(tar) {
  return Buffer.concat([fakeXzMagic, tar]);
}

async function fakeSign(debPath) {
  await writeFile(
    `${debPath}.sig`,
    `signature:${sha256(await readFile(debPath))}\n`,
  );
}

test("ar codec emits canonical Debian members and rejects extra members", () => {
  const archive = fixtureDeb();
  const members = parseArArchive(archive);
  const inspected = inspectDebMembers(members);

  assert.deepEqual(
    members.map((member) => member.name),
    ["debian-binary", "control.tar.gz", "data.tar.gz"],
  );
  assert.equal(inspected.debianBinary.data.toString("ascii"), "2.0\n");
  assert.equal(serializeArArchive(members).equals(archive), true);
  assert.throws(
    () =>
      inspectDebMembers([
        ...members,
        { name: "unexpected", data: Buffer.from("unexpected") },
      ]),
    /exactly three members/,
  );
});

test("repack changes only the data compression layer", async () => {
  const dataTar = fixtureDataTar();
  const source = fixtureDeb({ dataTar });
  const beforeMembers = parseArArchive(source);
  const beforeMetadata = readTarEntries(dataTar);
  const { output, report } = await buildRepackedDeb(source, {
    decompress: fakeDecompress,
    compress: fakeCompress,
  });
  const afterMembers = parseArArchive(output);
  const afterTar = await fakeDecompress(afterMembers[2]);

  assert.deepEqual(
    afterMembers.map((member) => member.name),
    ["debian-binary", "control.tar.gz", "data.tar.xz"],
  );
  assert.equal(afterMembers[0].data.equals(beforeMembers[0].data), true);
  assert.equal(afterMembers[1].data.equals(beforeMembers[1].data), true);
  assert.equal(afterTar.equals(dataTar), true);
  assert.deepEqual(readTarEntries(afterTar), beforeMetadata);
  assert.deepEqual(
    beforeMetadata.find((entry) => entry.name === "usr/bin/artistic-git"),
    {
      name: "usr/bin/artistic-git",
      mode: 0o755,
      uid: 123,
      gid: 456,
      mtime: 1_700_001_234,
      type: "0",
      linkName: "",
      sha256: sha256(Buffer.from("#!/bin/sh\necho fixture\n")),
    },
  );
  assert.equal(report.dataTar.byteIdentical, true);
  assert.equal(report.dataTar.sha256, sha256(dataTar));
  assert.equal(report.controlArchiveByteIdentical, true);
});

test("file repack validates and signs the candidate before publishing", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "artistic-git-deb-repack-"),
  );
  try {
    const debPath = path.join(root, "artistic-git_1.0.0_amd64.deb");
    const reportPath = path.join(root, "deb-repack-report.json");
    await writeFile(debPath, fixtureDeb());
    await chmod(debPath, 0o640);
    await writeFile(`${debPath}.sig`, "stale-signature\n");
    const calls = [];

    const result = await repackDebFile({
      debPath,
      reportPath,
      decompress: fakeDecompress,
      compress: fakeCompress,
      validateDeb: async (candidate) => {
        calls.push(["validate", path.basename(candidate)]);
        assert.equal(
          parseArArchive(await readFile(candidate))[2].name,
          "data.tar.xz",
        );
      },
      signDeb: async (candidate) => {
        calls.push(["sign", path.basename(candidate)]);
        await fakeSign(candidate);
      },
    });

    assert.deepEqual(calls, [
      ["validate", path.basename(debPath)],
      ["sign", path.basename(debPath)],
    ]);
    assert.equal(
      parseArArchive(await readFile(debPath))[2].name,
      "data.tar.xz",
    );
    assert.match(await readFile(`${debPath}.sig`, "utf8"), /^signature:/);
    if (process.platform !== "win32") {
      assert.equal((await stat(debPath)).mode & 0o777, 0o640);
    }
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.outputSha256, result.report.outputSha256);
    assert.equal(report.package, path.basename(debPath));
    assert.equal(report.signature, `${path.basename(debPath)}.sig`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repack is deterministic and idempotent before detached signing", async () => {
  const first = await buildRepackedDeb(fixtureDeb(), {
    decompress: fakeDecompress,
    compress: fakeCompress,
  });
  const second = await buildRepackedDeb(first.output, {
    decompress: fakeDecompress,
    compress: fakeCompress,
  });

  assert.equal(second.output.equals(first.output), true);
  assert.equal(second.report.outputSha256, first.report.outputSha256);
});

test("signing and evidence failures preserve the previous DEB and signature", async () => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "artistic-git-deb-rollback-"),
  );
  try {
    for (const failure of ["sign", "report"]) {
      const debPath = path.join(root, `${failure}.deb`);
      const signaturePath = `${debPath}.sig`;
      const original = fixtureDeb();
      const originalSignature = Buffer.from(`${failure}-signature\n`);
      await writeFile(debPath, original);
      await writeFile(signaturePath, originalSignature);

      await assert.rejects(
        () =>
          repackDebFile({
            debPath,
            reportPath:
              failure === "report"
                ? path.join(root, "missing", "report.json")
                : path.join(root, `${failure}.json`),
            decompress: fakeDecompress,
            compress: fakeCompress,
            validateDeb: async () => {},
            signDeb:
              failure === "sign"
                ? async () => {
                    throw new Error("signer failed");
                  }
                : fakeSign,
          }),
        failure === "sign" ? /signer failed/ : /ENOENT/,
      );
      assert.equal((await readFile(debPath)).equals(original), true);
      assert.equal(
        (await readFile(signaturePath)).equals(originalSignature),
        true,
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI requires both signing secrets before invoking repack", async () => {
  const args = ["--deb=fixture.deb", "--report=fixture.json"];
  let calls = 0;
  const repack = async () => {
    calls += 1;
  };

  await assert.rejects(
    () => runCli(args, { env: {}, repack }),
    /TAURI_SIGNING_PRIVATE_KEY is required/,
  );
  await assert.rejects(
    () =>
      runCli(args, {
        env: { TAURI_SIGNING_PRIVATE_KEY: "fixture-key" },
        repack,
      }),
    /TAURI_SIGNING_PRIVATE_KEY_PASSWORD is required/,
  );
  assert.equal(calls, 0);
});

test("CLI parser exposes no compression, signing, or validation bypass", () => {
  assert.deepEqual(
    parseArgs(["--deb=fixture.deb", "--report", "fixture.json"]),
    { debPath: "fixture.deb", reportPath: "fixture.json" },
  );
  for (const bypass of ["--skip-sign", "--skip-verify", "--compression=gzip"]) {
    assert.throws(
      () => parseArgs(["--deb=fixture.deb", "--report=fixture.json", bypass]),
      /unknown DEB repack argument/,
    );
  }
});

test("real xz -9e output round-trips the tar byte-for-byte", async (context) => {
  if (process.platform === "win32") {
    context.skip("xz is only required by the Linux packaging job");
    return;
  }
  try {
    await runCommand("xz", ["--version"]);
  } catch {
    context.skip("xz is not installed on this development host");
    return;
  }

  assert.deepEqual(xzCompressionArgs, [
    "--compress",
    "--stdout",
    "--threads=1",
    "-9e",
    "--check=crc64",
  ]);
  const tar = fixtureDataTar();
  const compressed = await compressTarWithXz(tar);
  const decompressed = await decompressDataTar({
    name: "data.tar.xz",
    data: compressed,
  });
  assert.equal(decompressed.equals(tar), true);
});

test("dpkg-deb accepts the generated Debian archive on Linux", async (context) => {
  if (process.platform !== "linux") {
    context.skip(
      "dpkg-deb compatibility is enforced by the Linux packaging job",
    );
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "artistic-git-dpkg-deb-"));
  try {
    const debPath = path.join(root, "fixture.deb");
    const { output } = await buildRepackedDeb(fixtureDeb());
    await writeFile(debPath, output);
    await validateDebWithDpkg(debPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
