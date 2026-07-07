#!/usr/bin/env node
/* global console, process */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const frontendSourceRoot = path.join(repoRoot, "src");
const resourcesPath = path.join(repoRoot, "src/i18n/resources.ts");
const formattersPath = path.join(repoRoot, "src/i18n/format.ts");

const skippedDirectories = new Set([
  ".git",
  "dist",
  "node_modules",
  "target",
  "src-tauri/gen",
]);

const frontendSourceExtensions = new Set([".ts", ".tsx"]);
const sourceExtensions = new Set([".rs", ".ts", ".tsx"]);
const uiSourcePrefixes = [
  "src/App.tsx",
  "src/AppProviders.tsx",
  "src/components/",
  "src/features/",
  "src/main.tsx",
];

const userVisibleJsxAttributes = new Set([
  "alt",
  "aria-label",
  "description",
  "label",
  "placeholder",
  "title",
]);

const userVisiblePropertyNames = new Set([
  "ariaLabel",
  "cancelLabel",
  "confirmLabel",
  "description",
  "emptyLabel",
  "error",
  "label",
  "message",
  "placeholder",
  "summary",
  "title",
  "tooltip",
]);

const knownTechnicalEnglishStrings = new Set([
  "Checking out files",
  "Clone complete",
  "Cloning repository",
  "Cloning submodules",
  "Downloading LFS objects",
  "Downloading submodule LFS objects",
  "Opening repository",
  "Submodules ready",
  "Updating submodules",
]);

const requiredFormatterSnippets = [
  {
    label: "localized date formatter",
    snippet: "new Intl.DateTimeFormat(language",
  },
  {
    label: "localized relative time formatter",
    snippet: "new Intl.RelativeTimeFormat(language",
  },
  {
    label: "localized number formatter",
    snippet: "new Intl.NumberFormat(language",
  },
  {
    label: "localized file size unit formatting",
    snippet: 'style: "unit"',
  },
];

const directFormattingPatterns = [
  {
    label: "direct locale date/time formatting outside i18n/format.ts",
    pattern: /\.toLocale(?:DateString|TimeString|String)\s*\(/,
  },
  {
    label: "direct Intl date/relative/number formatter outside i18n/format.ts",
    pattern:
      /new\s+Intl\.(?:DateTimeFormat|RelativeTimeFormat|NumberFormat)\s*\(/,
  },
];

const gitInvariantTokens = [
  {
    canonical: "Revert:",
    label: "git revert commit prefix",
    pattern: /(^|[^A-Za-z0-9_])revert:(?!:)/i,
  },
  {
    canonical: "Auto Stash:",
    label: "auto stash message prefix",
    pattern: /(^|[^A-Za-z0-9_])auto stash:/i,
  },
  {
    canonical: "backup/",
    label: "backup branch namespace",
    pattern: /backup\//i,
  },
];

const findings = [];
const counters = {
  frontendFiles: 0,
  resourceKeys: 0,
  sourceFiles: 0,
  uiFiles: 0,
};

const resourceAudit = await auditResourceShape();
await auditTranslationKeyUsage(resourceAudit.leafKeys);
await auditFrontendSourceText();
await auditUiSourceText();
await auditGitTextInvariants();
await auditRawStderr();
await auditLocalizedFormatting();

if (findings.length > 0) {
  console.error("i18n audit failed:");
  for (const finding of findings) {
    console.error(`  - ${formatFinding(finding)}`);
  }
  process.exit(1);
}

console.log(
  [
    "i18n-audit:",
    `checked ${counters.resourceKeys} resource keys`,
    `${counters.frontendFiles} frontend source files`,
    `${counters.uiFiles} UI files`,
    `${counters.sourceFiles} Rust/TS source files`,
    "with no findings.",
  ].join(" "),
);

async function auditResourceShape() {
  const sourceFile = await parseSourceFile(resourcesPath);
  const resources = findVariableInitializer(sourceFile, "resources");

  if (!resources || !ts.isObjectLiteralExpression(resources)) {
    addFinding({
      file: relativePath(resourcesPath),
      label: "resource shape",
      message: "Could not find an object literal export named resources.",
    });
    return { leafKeys: new Map() };
  }

  const enTranslation = getNestedObject(resources, ["en", "translation"]);
  const zhTranslation = getNestedObject(resources, ["zh-CN", "translation"]);

  if (!enTranslation || !zhTranslation) {
    addFinding({
      file: relativePath(resourcesPath),
      label: "resource shape",
      message: "Could not find both en.translation and zh-CN.translation.",
    });
    return { leafKeys: new Map() };
  }

  compareResourceObjects(enTranslation, zhTranslation, []);
  const leafKeys = collectResourceLeaves(enTranslation, []);
  counters.resourceKeys = leafKeys.size;
  return { leafKeys };
}

async function auditTranslationKeyUsage(resourceLeafKeys) {
  const files = await collectFiles(
    frontendSourceRoot,
    frontendSourceExtensions,
  );

  for (const filePath of files) {
    const relative = relativePath(filePath);
    if (isSkippedFrontendFile(relative)) {
      continue;
    }

    counters.frontendFiles += 1;
    const sourceFile = await parseSourceFile(filePath);

    visit(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !isTranslationCall(node)) {
        return;
      }

      const [keyArg] = node.arguments;
      if (!keyArg) {
        return;
      }

      if (ts.isStringLiteralLike(keyArg)) {
        const key = keyArg.text;
        if (!resourceLeafKeys.has(key)) {
          addNodeFinding(sourceFile, keyArg, {
            label: "missing translation key",
            message: `Translation key "${key}" is not present in resources.ts.`,
          });
        }
        return;
      }

      if (ts.isTemplateExpression(keyArg)) {
        const prefix = keyArg.head.text;
        if (
          prefix.length > 0 &&
          !Array.from(resourceLeafKeys.keys()).some((key) =>
            key.startsWith(prefix),
          )
        ) {
          addNodeFinding(sourceFile, keyArg, {
            label: "missing dynamic translation key prefix",
            message: `No resource key starts with dynamic prefix "${prefix}".`,
          });
        }
      }
    });
  }
}

async function auditFrontendSourceText() {
  const files = await collectFiles(
    frontendSourceRoot,
    frontendSourceExtensions,
  );

  for (const filePath of files) {
    const relative = relativePath(filePath);
    if (
      isSkippedFrontendFile(relative) ||
      relative === "src/i18n/resources.ts"
    ) {
      continue;
    }

    const text = await readFile(filePath, "utf8");
    text.split(/\r?\n/).forEach((line, index) => {
      if (/[\p{Script=Han}]/u.test(line)) {
        addFinding({
          file: relative,
          line: index + 1,
          label: "bare Chinese text",
          message:
            "Chinese UI text must live in src/i18n/resources.ts, not source code.",
          text: line.trim(),
        });
      }
    });
  }
}

async function auditUiSourceText() {
  const files = (
    await collectFiles(frontendSourceRoot, new Set([".tsx"]))
  ).filter((filePath) => isUiSourceFile(relativePath(filePath)));

  for (const filePath of files) {
    const relative = relativePath(filePath);
    if (isSkippedFrontendFile(relative)) {
      continue;
    }

    counters.uiFiles += 1;
    const sourceFile = await parseSourceFile(filePath);

    visit(sourceFile, (node) => {
      if (ts.isJsxText(node)) {
        const text = normalizeHumanText(node.getText(sourceFile));
        if (isSuspiciousHumanText(text)) {
          addNodeFinding(sourceFile, node, {
            label: "bare JSX text",
            message: `Move visible text "${text}" into i18n resources and render it with t(...).`,
          });
        }
        return;
      }

      if (
        ts.isJsxAttribute(node) &&
        userVisibleJsxAttributes.has(node.name.text) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer) &&
        isSuspiciousHumanText(node.initializer.text)
      ) {
        addNodeFinding(sourceFile, node.initializer, {
          label: "bare JSX attribute text",
          message: `Move ${node.name.text}="${node.initializer.text}" into i18n resources.`,
        });
        return;
      }

      if (
        ts.isJsxExpression(node) &&
        node.expression &&
        ts.isStringLiteralLike(node.expression) &&
        isSuspiciousHumanText(node.expression.text)
      ) {
        addNodeFinding(sourceFile, node.expression, {
          label: "bare JSX expression text",
          message: `Move visible text "${node.expression.text}" into i18n resources.`,
        });
        return;
      }

      if (
        ts.isPropertyAssignment(node) &&
        isUserVisiblePropertyName(node.name) &&
        isStaticStringNode(node.initializer) &&
        isSuspiciousHumanText(staticStringText(node.initializer)) &&
        !isAllowedTechnicalString(staticStringText(node.initializer), node)
      ) {
        addNodeFinding(sourceFile, node.initializer, {
          label: "bare UI property text",
          message: `Move ${propertyNameText(node.name)} text "${staticStringText(
            node.initializer,
          )}" into i18n resources, or add a narrow audit exception if it is protocol data.`,
        });
      }
    });
  }
}

async function auditGitTextInvariants() {
  const files = [
    ...(await collectFiles(path.join(repoRoot, "src"), sourceExtensions)),
    ...(await collectFiles(path.join(repoRoot, "crates"), sourceExtensions)),
    ...(await collectFiles(path.join(repoRoot, "src-tauri"), sourceExtensions)),
  ];
  const foundCanonicalTokens = new Set();

  for (const filePath of files) {
    const relative = relativePath(filePath);
    if (isSkippedSourceFile(relative)) {
      continue;
    }

    counters.sourceFiles += 1;
    const text = await readFile(filePath, "utf8");
    text.split(/\r?\n/).forEach((line, index) => {
      for (const token of gitInvariantTokens) {
        if (line.includes(token.canonical)) {
          foundCanonicalTokens.add(token.canonical);
        }

        if (token.pattern.test(line) && !line.includes(token.canonical)) {
          addFinding({
            file: relative,
            line: index + 1,
            label: token.label,
            message: `Use the canonical English token "${token.canonical}".`,
            text: line.trim(),
          });
        }
      }
    });
  }

  for (const token of gitInvariantTokens) {
    if (!foundCanonicalTokens.has(token.canonical)) {
      addFinding({
        file: ".",
        label: token.label,
        message: `Expected to find the canonical English token "${token.canonical}" in source.`,
      });
    }
  }
}

async function auditRawStderr() {
  const files = await collectFiles(
    frontendSourceRoot,
    frontendSourceExtensions,
  );

  for (const filePath of files) {
    const relative = relativePath(filePath);
    if (isSkippedFrontendFile(relative)) {
      continue;
    }

    const sourceFile = await parseSourceFile(filePath);
    visit(sourceFile, (node) => {
      if (!ts.isCallExpression(node) || !isTranslationCall(node)) {
        return;
      }

      if (
        node.arguments.some((argument) =>
          subtreeMentionsName(argument, "stderr"),
        )
      ) {
        addNodeFinding(sourceFile, node, {
          label: "translated stderr",
          message:
            "Do not pass raw stderr through t(...); show the original technical detail unchanged.",
        });
      }
    });
  }
}

async function auditLocalizedFormatting() {
  const formatterText = await readFile(formattersPath, "utf8");
  for (const { label, snippet } of requiredFormatterSnippets) {
    if (!formatterText.includes(snippet)) {
      addFinding({
        file: relativePath(formattersPath),
        label,
        message: `Expected formatter implementation to include ${snippet}.`,
      });
    }
  }

  const files = await collectFiles(
    frontendSourceRoot,
    frontendSourceExtensions,
  );
  for (const filePath of files) {
    const relative = relativePath(filePath);
    if (
      isSkippedFrontendFile(relative) ||
      relative === "src/i18n/format.ts" ||
      relative.endsWith(".d.ts")
    ) {
      continue;
    }

    const text = await readFile(filePath, "utf8");
    text.split(/\r?\n/).forEach((line, index) => {
      for (const { label, pattern } of directFormattingPatterns) {
        if (pattern.test(line)) {
          addFinding({
            file: relative,
            line: index + 1,
            label,
            message:
              "Use useLocalizedFormatters() or helpers from src/i18n/format.ts.",
            text: line.trim(),
          });
        }
      }
    });
  }
}

function compareResourceObjects(enObject, zhObject, keyPath) {
  const enProperties = objectProperties(enObject);
  const zhProperties = objectProperties(zhObject);
  const names = new Set([...enProperties.keys(), ...zhProperties.keys()]);

  for (const name of Array.from(names).sort()) {
    const nextPath = [...keyPath, name];
    const enValue = enProperties.get(name);
    const zhValue = zhProperties.get(name);

    if (!enValue) {
      addNodeFinding(zhObject.getSourceFile(), zhValue, {
        label: "extra zh-CN translation key",
        message: `zh-CN has "${nextPath.join(".")}" but en does not.`,
      });
      continue;
    }

    if (!zhValue) {
      addNodeFinding(enObject.getSourceFile(), enValue, {
        label: "missing zh-CN translation key",
        message: `en has "${nextPath.join(".")}" but zh-CN does not.`,
      });
      continue;
    }

    const enExpression = unwrapExpression(enValue);
    const zhExpression = unwrapExpression(zhValue);
    const enIsObject = ts.isObjectLiteralExpression(enExpression);
    const zhIsObject = ts.isObjectLiteralExpression(zhExpression);

    if (enIsObject !== zhIsObject) {
      addNodeFinding(enObject.getSourceFile(), enValue, {
        label: "translation key shape mismatch",
        message: `"${nextPath.join(".")}" is ${
          enIsObject ? "an object" : "a leaf"
        } in en and ${zhIsObject ? "an object" : "a leaf"} in zh-CN.`,
      });
      continue;
    }

    if (enIsObject && zhIsObject) {
      compareResourceObjects(enExpression, zhExpression, nextPath);
      continue;
    }

    compareInterpolationPlaceholders(enExpression, zhExpression, nextPath);
  }
}

function compareInterpolationPlaceholders(enValue, zhValue, keyPath) {
  if (!isStaticStringNode(enValue) || !isStaticStringNode(zhValue)) {
    return;
  }

  const enPlaceholders = interpolationPlaceholders(staticStringText(enValue));
  const zhPlaceholders = interpolationPlaceholders(staticStringText(zhValue));
  const names = new Set([...enPlaceholders, ...zhPlaceholders]);

  for (const name of Array.from(names).sort()) {
    if (!enPlaceholders.has(name)) {
      addNodeFinding(zhValue.getSourceFile(), zhValue, {
        label: "extra zh-CN interpolation placeholder",
        message: `zh-CN "${keyPath.join(".")}" uses "{{${name}}}" but en does not.`,
      });
    }

    if (!zhPlaceholders.has(name)) {
      addNodeFinding(enValue.getSourceFile(), enValue, {
        label: "missing zh-CN interpolation placeholder",
        message: `en "${keyPath.join(".")}" uses "{{${name}}}" but zh-CN does not.`,
      });
    }
  }
}

function collectResourceLeaves(object, keyPath) {
  const leaves = new Map();
  for (const [name, value] of objectProperties(object)) {
    const nextPath = [...keyPath, name];
    const expression = unwrapExpression(value);
    if (ts.isObjectLiteralExpression(expression)) {
      for (const [key, leaf] of collectResourceLeaves(expression, nextPath)) {
        leaves.set(key, leaf);
      }
    } else {
      leaves.set(nextPath.join("."), expression);
    }
  }
  return leaves;
}

function objectProperties(object) {
  const properties = new Map();

  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      addNodeFinding(object.getSourceFile(), property, {
        label: "unsupported translation resource syntax",
        message: "Translation resources must use plain property assignments.",
      });
      continue;
    }

    const name = propertyNameText(property.name);
    if (!name) {
      addNodeFinding(object.getSourceFile(), property.name, {
        label: "unsupported translation resource key",
        message:
          "Translation resource keys must be static strings or identifiers.",
      });
      continue;
    }

    properties.set(name, property.initializer);
  }

  return properties;
}

function getNestedObject(root, keyPath) {
  let current = root;

  for (const key of keyPath) {
    if (!current || !ts.isObjectLiteralExpression(current)) {
      return null;
    }

    current = unwrapExpression(objectProperties(current).get(key));
  }

  current = unwrapExpression(current);
  return current && ts.isObjectLiteralExpression(current) ? current : null;
}

function interpolationPlaceholders(value) {
  const placeholders = new Set();
  const pattern = /{{\s*([A-Za-z0-9_.-]+)\s*}}/g;
  let match;
  while ((match = pattern.exec(value))) {
    placeholders.add(match[1]);
  }
  return placeholders;
}

function findVariableInitializer(sourceFile, variableName) {
  let initializer = null;
  visit(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node)) {
      return;
    }

    if (ts.isIdentifier(node.name) && node.name.text === variableName) {
      initializer = unwrapExpression(node.initializer ?? null);
    }
  });
  return initializer;
}

function isTranslationCall(node) {
  return (
    (ts.isIdentifier(node.expression) && node.expression.text === "t") ||
    (ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "t")
  );
}

function subtreeMentionsName(node, name) {
  let found = false;
  visit(node, (child) => {
    if (
      (ts.isIdentifier(child) && child.text === name) ||
      (ts.isPropertyAccessExpression(child) && child.name.text === name) ||
      (ts.isPropertyAssignment(child) && propertyNameText(child.name) === name)
    ) {
      found = true;
    }
  });
  return found;
}

function normalizeHumanText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function isSuspiciousHumanText(value) {
  const text = normalizeHumanText(value);
  if (!text) {
    return false;
  }

  if (/[\p{Script=Han}]/u.test(text)) {
    return true;
  }

  if (isTechnicalText(text)) {
    return false;
  }

  return /[A-Za-z][A-Za-z'’.-]*\s+[A-Za-z][A-Za-z'’.-]*/.test(text);
}

function isTechnicalText(value) {
  return (
    knownTechnicalEnglishStrings.has(value) ||
    value.includes("{{") ||
    /^https?:\/\//.test(value) ||
    /^\/[^\s]+$/.test(value) ||
    /^[A-Za-z]:\\/.test(value) ||
    /^refs\//.test(value) ||
    /^[a-z][A-Za-z0-9_.:-]*$/.test(value) ||
    /^[A-Z0-9_.:-]+$/.test(value) ||
    /^#[0-9A-Fa-f]{3,8}$/.test(value)
  );
}

function isAllowedTechnicalString(value, node) {
  if (knownTechnicalEnglishStrings.has(value)) {
    return true;
  }

  if (isProtocolMessageProperty(node)) {
    return true;
  }

  if (isCaseClauseString(node)) {
    return true;
  }

  return false;
}

function isProtocolMessageProperty(node) {
  if (
    !ts.isPropertyAssignment(node) ||
    propertyNameText(node.name) !== "message"
  ) {
    return false;
  }

  const object = node.parent;
  if (!object || !ts.isObjectLiteralExpression(object)) {
    return false;
  }

  return object.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyNameText(property.name) === "reason" &&
      isStaticStringNode(property.initializer),
  );
}

function isCaseClauseString(node) {
  let current = node.parent;
  while (current) {
    if (ts.isCaseClause(current)) {
      return true;
    }
    if (
      ts.isBlock(current) ||
      ts.isSourceFile(current) ||
      ts.isFunctionLike(current)
    ) {
      return false;
    }
    current = current.parent;
  }
  return false;
}

function isUserVisiblePropertyName(name) {
  const text = propertyNameText(name);
  return Boolean(text && userVisiblePropertyNames.has(text));
}

function propertyNameText(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) {
    return name.text;
  }

  if (ts.isNumericLiteral(name)) {
    return name.text;
  }

  return null;
}

function isStaticStringNode(node) {
  return (
    ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)
  );
}

function staticStringText(node) {
  return node.text;
}

function unwrapExpression(node) {
  let current = node;
  while (current) {
    if (
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current)
    ) {
      current = current.expression;
    } else {
      return current;
    }
  }
  return current;
}

async function parseSourceFile(filePath) {
  const text = await readFile(filePath, "utf8");
  const scriptKind = filePath.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  return ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
}

async function collectFiles(root, extensions) {
  const files = [];
  await collectFilesFrom(root, extensions, files);
  return files;
}

async function collectFilesFrom(filePath, extensions, files) {
  const relative = relativePath(filePath);
  if (isSkippedDirectory(relative)) {
    return;
  }

  let entries;
  try {
    entries = await readdir(filePath, { withFileTypes: true });
  } catch {
    if (extensions.has(path.extname(filePath))) {
      files.push(filePath);
    }
    return;
  }

  for (const entry of entries) {
    const child = path.join(filePath, entry.name);
    if (entry.isDirectory()) {
      await collectFilesFrom(child, extensions, files);
    } else if (entry.isFile() && extensions.has(path.extname(entry.name))) {
      files.push(child);
    }
  }
}

function isSkippedDirectory(relative) {
  return Array.from(skippedDirectories).some(
    (skipped) => relative === skipped || relative.startsWith(`${skipped}/`),
  );
}

function isSkippedFrontendFile(relative) {
  return (
    relative.endsWith(".d.ts") ||
    relative.includes(".test.") ||
    relative.includes("/fixtures.") ||
    relative === "src/test/setup.ts" ||
    relative === "src/lib/ipc/generated.ts"
  );
}

function isSkippedSourceFile(relative) {
  return (
    isSkippedFrontendFile(relative) ||
    relative === "src/i18n/resources.ts" ||
    relative.endsWith(".snap")
  );
}

function isUiSourceFile(relative) {
  return uiSourcePrefixes.some(
    (prefix) => relative === prefix || relative.startsWith(prefix),
  );
}

function visit(node, visitor) {
  visitor(node);
  if (findings.length > 1000) {
    return;
  }
  ts.forEachChild(node, (child) => visit(child, visitor));
}

function addNodeFinding(sourceFile, node, finding) {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  addFinding({
    file: relativePath(sourceFile.fileName),
    line: position.line + 1,
    column: position.character + 1,
    ...finding,
  });
}

function addFinding(finding) {
  findings.push(finding);
}

function formatFinding(finding) {
  const location = finding.line
    ? `${finding.file}:${finding.line}${finding.column ? `:${finding.column}` : ""}`
    : finding.file;
  const text = finding.text ? ` (${finding.text})` : "";
  return `${location}: ${finding.label}: ${finding.message}${text}`;
}

function relativePath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}
