#!/usr/bin/env node
/* global console, process */

import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const arMagic = Buffer.from("!<arch>\n", "ascii");
const arHeaderBytes = 60;
const maximumCommandOutputBytes = 512 * 1024 * 1024;
const scriptPath = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === scriptPath;

export const xzCompressionArgs = [
  "--compress",
  "--stdout",
  "--threads=1",
  "-9e",
  "--check=crc64",
];

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseDecimalField(header, start, width, label) {
  const value = header
    .subarray(start, start + width)
    .toString("ascii")
    .trim();
  if (!/^\d+$/.test(value)) {
    fail(`invalid ar ${label}: ${JSON.stringify(value)}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    fail(`ar ${label} is outside the supported range: ${value}`);
  }
  return parsed;
}

export function parseArArchive(archive) {
  if (!Buffer.isBuffer(archive) || !archive.subarray(0, 8).equals(arMagic)) {
    fail("invalid Debian ar archive magic");
  }

  const members = [];
  let offset = arMagic.length;
  while (offset < archive.length) {
    if (offset + arHeaderBytes > archive.length) {
      fail(`truncated ar member header at byte ${offset}`);
    }
    const header = archive.subarray(offset, offset + arHeaderBytes);
    if (header.subarray(58, 60).toString("ascii") !== "`\n") {
      fail(`invalid ar member header trailer at byte ${offset}`);
    }
    const identifier = header.subarray(0, 16).toString("ascii").trim();
    if (!identifier.endsWith("/") || identifier.startsWith("#1/")) {
      fail(`unsupported ar member identifier: ${JSON.stringify(identifier)}`);
    }
    const name = identifier.slice(0, -1);
    if (!name || name.includes("/") || name.length > 15) {
      fail(`invalid ar member name: ${JSON.stringify(name)}`);
    }

    const size = parseDecimalField(header, 48, 10, `${name} size`);
    const dataStart = offset + arHeaderBytes;
    const dataEnd = dataStart + size;
    if (dataEnd > archive.length) {
      fail(`truncated ar member ${name}: expected ${size} bytes`);
    }
    members.push({
      name,
      data: Buffer.from(archive.subarray(dataStart, dataEnd)),
    });
    offset = dataEnd;
    if (size % 2 === 1) {
      if (archive[offset] !== 0x0a) {
        fail(`invalid ar padding after member ${name}`);
      }
      offset += 1;
    }
  }

  if (offset !== archive.length) {
    fail("ar archive has trailing bytes");
  }
  return members;
}

function formatArField(value, width, label) {
  const text = String(value);
  if (Buffer.byteLength(text, "ascii") > width) {
    fail(`ar ${label} does not fit in ${width} bytes: ${text}`);
  }
  return text.padEnd(width, " ");
}

export function serializeArArchive(members) {
  const chunks = [arMagic];
  for (const member of members) {
    if (
      !member ||
      typeof member.name !== "string" ||
      !member.name ||
      member.name.includes("/") ||
      member.name.length > 15 ||
      !Buffer.isBuffer(member.data)
    ) {
      fail("invalid ar member supplied for serialization");
    }
    const header = Buffer.from(
      [
        formatArField(`${member.name}/`, 16, "member name"),
        formatArField("0", 12, "timestamp"),
        formatArField("0", 6, "owner"),
        formatArField("0", 6, "group"),
        formatArField("100644", 8, "mode"),
        formatArField(member.data.length, 10, "member size"),
        "`\n",
      ].join(""),
      "ascii",
    );
    if (header.length !== arHeaderBytes) {
      fail(`internal ar header length error for ${member.name}`);
    }
    chunks.push(header, member.data);
    if (member.data.length % 2 === 1) {
      chunks.push(Buffer.from("\n", "ascii"));
    }
  }
  return Buffer.concat(chunks);
}

export function inspectDebMembers(members) {
  const names = members.map((member) => member.name);
  if (members.length !== 3) {
    fail(
      `Debian archive must contain exactly three members, found: ${names.join(", ")}`,
    );
  }
  if (names[0] !== "debian-binary") {
    fail(
      `first Debian archive member must be debian-binary, found: ${names[0]}`,
    );
  }
  if (!/^control\.tar(?:\.(?:gz|xz|zst|bz2))?$/.test(names[1])) {
    fail(
      `second Debian archive member must be control.tar.*, found: ${names[1]}`,
    );
  }
  if (!/^data\.tar(?:\.(?:gz|xz|zst|bz2))?$/.test(names[2])) {
    fail(`third Debian archive member must be data.tar.*, found: ${names[2]}`);
  }
  if (!members[0].data.equals(Buffer.from("2.0\n", "ascii"))) {
    fail("debian-binary must contain exactly '2.0\\n'");
  }
  return {
    debianBinary: members[0],
    control: members[1],
    data: members[2],
  };
}

export async function runCommand(
  command,
  args,
  {
    cwd,
    env = process.env,
    input,
    maximumOutputBytes = maximumCommandOutputBytes,
  } = {},
) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let outputLimitError;

    const append = (chunks, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maximumOutputBytes && !outputLimitError) {
        outputLimitError = new Error(
          `${command} produced more than ${maximumOutputBytes} bytes of output`,
        );
        child.kill();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (outputLimitError) {
        reject(outputLimitError);
        return;
      }
      const result = {
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (code !== 0) {
        const detail = result.stderr.toString("utf8").trim();
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}${detail ? `: ${detail}` : ""}`,
          ),
        );
        return;
      }
      resolve(result);
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") {
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

export async function decompressDataTar(member, commandRunner = runCommand) {
  if (member.name === "data.tar") {
    return Buffer.from(member.data);
  }
  if (member.name === "data.tar.gz") {
    return gunzipSync(member.data);
  }
  if (member.name === "data.tar.xz") {
    return (
      await commandRunner("xz", ["--decompress", "--stdout"], {
        input: member.data,
      })
    ).stdout;
  }
  if (member.name === "data.tar.zst") {
    return (
      await commandRunner("zstd", ["--decompress", "--stdout"], {
        input: member.data,
      })
    ).stdout;
  }
  if (member.name === "data.tar.bz2") {
    return (
      await commandRunner("bzip2", ["--decompress", "--stdout"], {
        input: member.data,
      })
    ).stdout;
  }
  fail(`unsupported Debian data archive compression: ${member.name}`);
}

export async function compressTarWithXz(tar, commandRunner = runCommand) {
  return (await commandRunner("xz", xzCompressionArgs, { input: tar })).stdout;
}

function summarizeMembers(members) {
  return members.map((member) => ({
    name: member.name,
    bytes: member.data.length,
    sha256: sha256(member.data),
  }));
}

export async function buildRepackedDeb(
  source,
  { decompress = decompressDataTar, compress = compressTarWithXz } = {},
) {
  const sourceMembers = parseArArchive(source);
  const inspected = inspectDebMembers(sourceMembers);
  const tar = await decompress(inspected.data);
  const compressed = await compress(tar);
  if (!Buffer.isBuffer(compressed) || compressed.length === 0) {
    fail("xz compressor returned an empty or invalid result");
  }

  const outputMembers = sourceMembers.map((member, index) =>
    index === 2 ? { name: "data.tar.xz", data: compressed } : member,
  );
  const output = serializeArArchive(outputMembers);
  const parsedOutput = parseArArchive(output);
  const outputInspected = inspectDebMembers(parsedOutput);
  const verifiedTar = await decompress(outputInspected.data);
  if (!verifiedTar.equals(tar)) {
    fail("repacked data.tar.xz does not match the original tar byte-for-byte");
  }
  if (!parsedOutput[1].data.equals(sourceMembers[1].data)) {
    fail("repacked Debian control archive changed unexpectedly");
  }

  return {
    output,
    report: {
      schemaVersion: 1,
      format: "debian-binary-package",
      inputSha256: sha256(source),
      outputSha256: sha256(output),
      membersBefore: summarizeMembers(sourceMembers),
      membersAfter: summarizeMembers(parsedOutput),
      dataTar: {
        inputMember: inspected.data.name,
        outputMember: outputInspected.data.name,
        bytes: tar.length,
        sha256: sha256(tar),
        byteIdentical: true,
      },
      controlArchiveByteIdentical: true,
      compression: {
        command: "xz",
        arguments: xzCompressionArgs,
      },
    },
  };
}

export async function validateDebWithDpkg(debPath, commandRunner = runCommand) {
  await commandRunner("dpkg-deb", ["--info", debPath]);
  await commandRunner("dpkg-deb", ["--contents", debPath]);
}

export async function signDebWithTauri(
  debPath,
  { commandRunner = runCommand, env = process.env } = {},
) {
  await commandRunner("pnpm", ["tauri", "signer", "sign", debPath], { env });
}

async function restoreFile(filePath, contents, mode, temporaryDirectory) {
  const restorePath = path.join(
    temporaryDirectory,
    `${path.basename(filePath)}.restore`,
  );
  await writeFile(restorePath, contents);
  await chmod(restorePath, mode);
  await rename(restorePath, filePath);
}

export async function repackDebFile({
  debPath,
  reportPath,
  decompress = decompressDataTar,
  compress = compressTarWithXz,
  validateDeb = validateDebWithDpkg,
  signDeb = signDebWithTauri,
}) {
  const resolvedDebPath = path.resolve(debPath);
  const debStat = await stat(resolvedDebPath).catch(() => null);
  if (!debStat?.isFile()) {
    fail(
      `DEB package does not exist or is not a regular file: ${resolvedDebPath}`,
    );
  }
  const signaturePath = `${resolvedDebPath}.sig`;
  const source = await readFile(resolvedDebPath);
  const existingSignatureStat = await lstat(signaturePath).catch(() => null);
  if (existingSignatureStat && !existingSignatureStat.isFile()) {
    fail(`existing DEB signature is not a regular file: ${signaturePath}`);
  }
  const existingSignature = existingSignatureStat
    ? await readFile(signaturePath)
    : undefined;
  const temporaryDirectory = await mkdtemp(
    path.join(path.dirname(resolvedDebPath), ".artistic-git-deb-repack-"),
  );
  const candidatePath = path.join(
    temporaryDirectory,
    path.basename(resolvedDebPath),
  );
  const candidateSignaturePath = `${candidatePath}.sig`;
  let replaced = false;

  try {
    const { output, report } = await buildRepackedDeb(source, {
      decompress,
      compress,
    });
    await writeFile(candidatePath, output);
    await chmod(candidatePath, debStat.mode & 0o777);
    await validateDeb(candidatePath);
    await signDeb(candidatePath);

    const candidateSignatureStat = await stat(candidateSignaturePath).catch(
      () => null,
    );
    if (
      !candidateSignatureStat?.isFile() ||
      candidateSignatureStat.size === 0
    ) {
      fail(
        `Tauri signer did not create a non-empty signature: ${candidateSignaturePath}`,
      );
    }

    await rename(candidatePath, resolvedDebPath);
    replaced = true;
    await rename(candidateSignaturePath, signaturePath);
    const published = await readFile(resolvedDebPath);
    if (sha256(published) !== report.outputSha256) {
      fail("published DEB does not match the validated repack candidate");
    }
    if (reportPath) {
      await writeFile(
        path.resolve(reportPath),
        `${JSON.stringify(
          {
            ...report,
            package: path.basename(resolvedDebPath),
            signature: path.basename(signaturePath),
          },
          null,
          2,
        )}\n`,
      );
    }
    return { debPath: resolvedDebPath, signaturePath, report };
  } catch (error) {
    if (replaced) {
      await restoreFile(
        resolvedDebPath,
        source,
        debStat.mode & 0o777,
        temporaryDirectory,
      );
      if (existingSignature !== undefined) {
        await restoreFile(
          signaturePath,
          existingSignature,
          existingSignatureStat.mode & 0o777,
          temporaryDirectory,
        );
      } else {
        await rm(signaturePath, { force: true });
      }
    }
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function optionValue(args, index, name) {
  const argument = args[index];
  if (argument === name) {
    if (!args[index + 1]) {
      fail(`${name} requires a value`);
    }
    return { value: args[index + 1], consumed: 2 };
  }
  if (argument.startsWith(`${name}=`)) {
    const value = argument.slice(name.length + 1);
    if (!value) {
      fail(`${name} requires a value`);
    }
    return { value, consumed: 1 };
  }
  return null;
}

export function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length;) {
    let parsed;
    if ((parsed = optionValue(args, index, "--deb"))) {
      options.debPath = parsed.value;
    } else if ((parsed = optionValue(args, index, "--report"))) {
      options.reportPath = parsed.value;
    } else {
      fail(`unknown DEB repack argument: ${args[index]}`);
    }
    index += parsed.consumed;
  }
  if (!options.debPath) {
    fail("--deb is required");
  }
  if (!options.reportPath) {
    fail("--report is required");
  }
  return options;
}

export async function runCli(
  args = process.argv.slice(2),
  { env = process.env, repack = repackDebFile } = {},
) {
  const options = parseArgs(args);
  if (!env.TAURI_SIGNING_PRIVATE_KEY) {
    fail("TAURI_SIGNING_PRIVATE_KEY is required to re-sign the repacked DEB");
  }
  if (!env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD) {
    fail(
      "TAURI_SIGNING_PRIVATE_KEY_PASSWORD is required to re-sign the repacked DEB",
    );
  }
  const result = await repack({
    ...options,
    signDeb: (debPath) => signDebWithTauri(debPath, { env }),
  });
  console.log(`repacked DEB with xz -9e: ${result.debPath}`);
  console.log(`signed repacked DEB: ${result.signaturePath}`);
  return result;
}

if (isMain) {
  await runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
