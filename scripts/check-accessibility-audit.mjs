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
const stylesPath = path.join(repoRoot, "src/styles.css");

const skippedDirectories = new Set([
  ".git",
  "dist",
  "node_modules",
  "target",
  "src-tauri/gen",
]);

const jsxExtensions = new Set([".tsx"]);
const sourceExtensions = new Set([".tsx", ".css"]);
const uiSourcePrefixes = [
  "src/App.tsx",
  "src/AppProviders.tsx",
  "src/components/",
  "src/features/",
  "src/main.tsx",
];

const accessibleNameAttributes = ["aria-label", "aria-labelledby", "title"];
const tooltipAttributes = ["aria-describedby", "title", "tooltip"];
const visibleTextAttributes = ["alt", "aria-label", "label", "text", "title"];
const keyboardHandlerAttributes = ["onKeyDown", "onKeyPress", "onKeyUp"];
const clickHandlerAttributes = ["onClick"];
const namedCompositeRoles = new Set(["listbox", "menu", "tablist"]);
const interactiveRoles = new Set([
  "button",
  "checkbox",
  "menuitem",
  "option",
  "radio",
  "switch",
  "tab",
]);
const nativeInteractiveTags = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
]);

const lowContrastPatterns = [
  {
    label: "transparent text",
    pattern: /\btext-transparent\b/,
    isAllowed: (line) => /\bbg-clip-text\b/.test(line),
    message:
      "Transparent text needs an explicit bg-clip-text treatment; avoid invisible copy.",
  },
  {
    label: "low-opacity text",
    pattern:
      /\btext-(?:black|white|foreground|card-foreground|primary-foreground|secondary-foreground|destructive-foreground)\/(?:[0-5]?\d|60)\b/,
    message:
      "Avoid low-opacity foreground text; use a theme token such as text-muted-foreground.",
  },
  {
    label: "low-opacity inline color",
    pattern:
      /color\s*:\s*(?:rgba\([^)]*,\s*0\.[0-6]\d*\)|hsl\([^)]*\/\s*0\.[0-6]\d*\))/,
    message:
      "Avoid inline low-opacity text colors; use reviewed theme tokens instead.",
  },
];

const findings = [];
const counters = {
  cssFiles: 0,
  jsxFiles: 0,
  sourceFiles: 0,
};

await auditJsxAccessibility();
await auditReducedMotionSupport();
await auditLowContrastRisks();

if (findings.length > 0) {
  console.error("accessibility audit failed:");
  for (const finding of findings) {
    console.error(`  - ${formatFinding(finding)}`);
  }
  process.exit(1);
}

console.log(
  [
    "accessibility-audit:",
    `checked ${counters.jsxFiles} JSX files`,
    `${counters.cssFiles} CSS entrypoint`,
    `${counters.sourceFiles} source files`,
    "with no findings.",
  ].join(" "),
);

async function auditJsxAccessibility() {
  const files = (await collectFiles(frontendSourceRoot, jsxExtensions)).filter(
    (filePath) => isUiSourceFile(relativePath(filePath)),
  );

  for (const filePath of files) {
    const relative = relativePath(filePath);
    if (isSkippedFrontendFile(relative)) {
      continue;
    }

    counters.jsxFiles += 1;
    const sourceFile = await parseSourceFile(filePath);

    visit(sourceFile, (node) => {
      if (ts.isJsxElement(node)) {
        auditJsxOpening(sourceFile, node.openingElement, node.children);
        return;
      }

      if (ts.isJsxSelfClosingElement(node)) {
        auditJsxOpening(sourceFile, node, []);
      }
    });
  }
}

function auditJsxOpening(sourceFile, opening, children) {
  const tagName = jsxTagName(opening.tagName, sourceFile);
  const role = staticAttributeText(opening, "role", sourceFile);

  auditIconButton(sourceFile, opening, tagName, children);
  auditBareClickHandler(sourceFile, opening, tagName);
  auditRoleAttributes(sourceFile, opening, tagName, role);
  auditAriaStateAttributes(sourceFile, opening, tagName, role);
}

function auditIconButton(sourceFile, opening, tagName, children) {
  if (tagName === "IconButton") {
    if (
      !hasAnyMeaningfulAttribute(
        opening,
        ["label", ...accessibleNameAttributes],
        sourceFile,
      )
    ) {
      addNodeFinding(sourceFile, opening, {
        label: "icon button name",
        message:
          "IconButton must provide label, aria-label, aria-labelledby, or title.",
      });
    }
    return;
  }

  if (!isButtonTag(tagName)) {
    return;
  }

  const hasVisibleContent = childrenHaveVisibleContent(children, sourceFile);
  const hasIconContent = childrenHaveIconContent(children, sourceFile);
  const sizedAsIcon =
    staticAttributeText(opening, "size", sourceFile) === "icon";
  const needsAccessibleName = sizedAsIcon || !hasVisibleContent;
  const isIconOnly = sizedAsIcon || (hasIconContent && !hasVisibleContent);

  if (
    needsAccessibleName &&
    !hasAnyMeaningfulAttribute(opening, accessibleNameAttributes, sourceFile)
  ) {
    addNodeFinding(sourceFile, opening, {
      label: "button accessible name",
      message:
        "Button with no visible text must have aria-label, aria-labelledby, or title.",
    });
  }

  if (
    isIconOnly &&
    !hasAnyMeaningfulAttribute(opening, tooltipAttributes, sourceFile)
  ) {
    addNodeFinding(sourceFile, opening, {
      label: "icon button tooltip",
      message:
        "Icon-only buttons should expose a tooltip/title mechanism such as aria-describedby, title, or IconButton.tooltip.",
    });
  }
}

function auditBareClickHandler(sourceFile, opening, tagName) {
  if (tagName !== "div" && tagName !== "span") {
    return;
  }

  if (!hasAnyAttribute(opening, clickHandlerAttributes, sourceFile)) {
    return;
  }

  const missing = [];
  if (!hasMeaningfulAttribute(opening, "role", sourceFile)) {
    missing.push("role");
  }
  if (!hasFocusableTabIndex(opening, sourceFile)) {
    missing.push("tabIndex={0}");
  }
  if (!hasAnyAttribute(opening, keyboardHandlerAttributes, sourceFile)) {
    missing.push("keyboard handler");
  }

  if (missing.length > 0) {
    addNodeFinding(sourceFile, opening, {
      label: "non-native click target",
      message: `Bare ${tagName} onClick target is missing ${missing.join(
        ", ",
      )}. Use a native button when possible.`,
    });
  }
}

function auditRoleAttributes(sourceFile, opening, tagName, role) {
  if (!role) {
    return;
  }

  if (role === "dialog") {
    if (!hasAnyAttribute(opening, ["aria-modal"], sourceFile)) {
      addNodeFinding(sourceFile, opening, {
        label: "dialog aria-modal",
        message:
          'Elements with role="dialog" must explicitly declare whether they are modal.',
      });
    }

    if (
      !hasAnyMeaningfulAttribute(
        opening,
        ["aria-label", "aria-labelledby"],
        sourceFile,
      )
    ) {
      addNodeFinding(sourceFile, opening, {
        label: "dialog name",
        message:
          'Elements with role="dialog" must have aria-label or aria-labelledby.',
      });
    }
  }

  if (
    namedCompositeRoles.has(role) &&
    !hasAnyMeaningfulAttribute(
      opening,
      ["aria-label", "aria-labelledby"],
      sourceFile,
    )
  ) {
    addNodeFinding(sourceFile, opening, {
      label: `${role} name`,
      message: `Elements with role="${role}" must have aria-label or aria-labelledby.`,
    });
  }

  if (
    interactiveRoles.has(role) &&
    !nativeInteractiveTags.has(tagName) &&
    !hasFocusableTabIndex(opening, sourceFile)
  ) {
    addNodeFinding(sourceFile, opening, {
      label: "interactive role focus",
      message: `Non-native elements with role="${role}" must be keyboard-focusable.`,
    });
  }
}

function auditAriaStateAttributes(sourceFile, opening, tagName, role) {
  if (
    hasMeaningfulAttribute(opening, "aria-haspopup", sourceFile) &&
    !hasMeaningfulAttribute(opening, "aria-expanded", sourceFile)
  ) {
    addNodeFinding(sourceFile, opening, {
      label: "popup state",
      message:
        "Controls with aria-haspopup should also expose aria-expanded state.",
    });
  }

  if (
    hasMeaningfulAttribute(opening, "aria-expanded", sourceFile) &&
    !isButtonTag(tagName) &&
    role !== "button" &&
    role !== "combobox"
  ) {
    addNodeFinding(sourceFile, opening, {
      label: "expanded control",
      message:
        "aria-expanded belongs on a button-like control or an element with an interactive role.",
    });
  }

  if (
    hasMeaningfulAttribute(opening, "aria-pressed", sourceFile) &&
    !isButtonTag(tagName) &&
    role !== "button"
  ) {
    addNodeFinding(sourceFile, opening, {
      label: "pressed control",
      message:
        'aria-pressed belongs on a native button or an element with role="button".',
    });
  }

  if (role === "progressbar") {
    for (const attributeName of ["aria-valuemax", "aria-valuemin"]) {
      if (!hasMeaningfulAttribute(opening, attributeName, sourceFile)) {
        addNodeFinding(sourceFile, opening, {
          label: "progressbar range",
          message: `Progressbar elements must include ${attributeName}.`,
        });
      }
    }
  }
}

async function auditReducedMotionSupport() {
  const css = await readFile(stylesPath, "utf8");
  counters.cssFiles += 1;

  if (!/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/.test(css)) {
    addFinding({
      file: relativePath(stylesPath),
      label: "reduced motion",
      message:
        "Expected a prefers-reduced-motion: reduce media query in the CSS entrypoint.",
    });
  }

  for (const { label, pattern } of [
    {
      label: "reduced animation duration",
      pattern: /animation-duration\s*:\s*(?:0|1ms)/,
    },
    {
      label: "reduced transition duration",
      pattern: /transition-duration\s*:\s*(?:0|1ms)/,
    },
    {
      label: "reduced scroll behavior",
      pattern: /scroll-behavior\s*:\s*auto/,
    },
  ]) {
    if (!pattern.test(css)) {
      addFinding({
        file: relativePath(stylesPath),
        label,
        message:
          "Reduced-motion media query must downgrade animation, transition, and scroll effects.",
      });
    }
  }
}

async function auditLowContrastRisks() {
  const files = [
    ...(await collectFiles(frontendSourceRoot, jsxExtensions)),
    stylesPath,
  ];

  for (const filePath of files) {
    const relative = relativePath(filePath);
    if (!sourceExtensions.has(path.extname(filePath))) {
      continue;
    }
    if (relative.endsWith(".tsx") && !isUiSourceFile(relative)) {
      continue;
    }
    if (isSkippedFrontendFile(relative)) {
      continue;
    }

    counters.sourceFiles += 1;
    const text = await readFile(filePath, "utf8");
    text.split(/\r?\n/).forEach((line, index) => {
      for (const {
        isAllowed,
        label,
        message,
        pattern,
      } of lowContrastPatterns) {
        if (pattern.test(line) && !isAllowed?.(line)) {
          addFinding({
            file: relative,
            line: index + 1,
            label,
            message,
            text: line.trim(),
          });
        }
      }
    });
  }
}

function childrenHaveVisibleContent(children, sourceFile) {
  return children.some((child) => nodeHasVisibleContent(child, sourceFile));
}

function nodeHasVisibleContent(node, sourceFile) {
  if (ts.isJsxText(node)) {
    return normalizeVisibleText(node.getText(sourceFile)).length > 0;
  }

  if (ts.isJsxExpression(node)) {
    return expressionHasVisibleContent(node.expression, sourceFile);
  }

  if (ts.isJsxElement(node)) {
    return elementHasVisibleContent(
      node.openingElement,
      node.children,
      sourceFile,
    );
  }

  if (ts.isJsxSelfClosingElement(node)) {
    return elementHasVisibleContent(node, [], sourceFile);
  }

  if (ts.isJsxFragment(node)) {
    return childrenHaveVisibleContent(node.children, sourceFile);
  }

  return false;
}

function elementHasVisibleContent(opening, children, sourceFile) {
  if (hasTrueAttribute(opening, "aria-hidden", sourceFile)) {
    return false;
  }

  if (hasAnyMeaningfulAttribute(opening, visibleTextAttributes, sourceFile)) {
    return true;
  }

  return childrenHaveVisibleContent(children, sourceFile);
}

function expressionHasVisibleContent(expression, sourceFile) {
  const node = unwrapExpression(expression);
  if (!node) {
    return false;
  }

  if (
    ts.isStringLiteralLike(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    return normalizeVisibleText(node.text).length > 0;
  }

  if (ts.isNumericLiteral(node)) {
    return true;
  }

  if (
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.UndefinedKeyword
  ) {
    return false;
  }

  if (ts.isConditionalExpression(node)) {
    return (
      expressionHasVisibleContent(node.whenTrue, sourceFile) ||
      expressionHasVisibleContent(node.whenFalse, sourceFile)
    );
  }

  if (ts.isBinaryExpression(node)) {
    return (
      expressionHasVisibleContent(node.left, sourceFile) ||
      expressionHasVisibleContent(node.right, sourceFile)
    );
  }

  if (ts.isTemplateExpression(node)) {
    return (
      normalizeVisibleText(node.head.text).length > 0 ||
      node.templateSpans.some(
        (span) =>
          expressionHasVisibleContent(span.expression, sourceFile) ||
          normalizeVisibleText(span.literal.text).length > 0,
      )
    );
  }

  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
    return true;
  }

  if (ts.isCallExpression(node)) {
    return isTranslationCall(node);
  }

  if (ts.isJsxElement(node)) {
    return elementHasVisibleContent(
      node.openingElement,
      node.children,
      sourceFile,
    );
  }

  if (ts.isJsxSelfClosingElement(node)) {
    return elementHasVisibleContent(node, [], sourceFile);
  }

  if (ts.isJsxFragment(node)) {
    return childrenHaveVisibleContent(node.children, sourceFile);
  }

  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.some((element) =>
      expressionHasVisibleContent(element, sourceFile),
    );
  }

  return false;
}

function childrenHaveIconContent(children, sourceFile) {
  return children.some((child) => nodeHasIconContent(child, sourceFile));
}

function nodeHasIconContent(node, sourceFile) {
  if (ts.isJsxElement(node)) {
    return (
      isLikelyIconElement(node.openingElement, sourceFile) ||
      childrenHaveIconContent(node.children, sourceFile)
    );
  }

  if (ts.isJsxSelfClosingElement(node)) {
    return isLikelyIconElement(node, sourceFile);
  }

  if (ts.isJsxExpression(node)) {
    const expression = unwrapExpression(node.expression);
    if (!expression) {
      return false;
    }

    if (ts.isConditionalExpression(expression)) {
      return (
        expressionHasIconContent(expression.whenTrue, sourceFile) ||
        expressionHasIconContent(expression.whenFalse, sourceFile)
      );
    }

    if (ts.isJsxElement(expression)) {
      return (
        isLikelyIconElement(expression.openingElement, sourceFile) ||
        childrenHaveIconContent(expression.children, sourceFile)
      );
    }

    if (ts.isJsxSelfClosingElement(expression)) {
      return isLikelyIconElement(expression, sourceFile);
    }
  }

  return false;
}

function expressionHasIconContent(expression, sourceFile) {
  const node = unwrapExpression(expression);
  if (!node) {
    return false;
  }

  if (ts.isJsxElement(node)) {
    return (
      isLikelyIconElement(node.openingElement, sourceFile) ||
      childrenHaveIconContent(node.children, sourceFile)
    );
  }

  if (ts.isJsxSelfClosingElement(node)) {
    return isLikelyIconElement(node, sourceFile);
  }

  if (ts.isConditionalExpression(node)) {
    return (
      expressionHasIconContent(node.whenTrue, sourceFile) ||
      expressionHasIconContent(node.whenFalse, sourceFile)
    );
  }

  return false;
}

function isLikelyIconElement(opening, sourceFile) {
  const tagName = jsxTagName(opening.tagName, sourceFile);
  if (tagName === "svg") {
    return true;
  }

  if (!/^[A-Z]/.test(tagName)) {
    return false;
  }

  if (hasAnyMeaningfulAttribute(opening, visibleTextAttributes, sourceFile)) {
    return false;
  }

  if (hasTrueAttribute(opening, "aria-hidden", sourceFile)) {
    return true;
  }

  return classNameTokens(opening, sourceFile).some((token) =>
    /^(?:size|h|w)-/.test(token),
  );
}

function isButtonTag(tagName) {
  return (
    tagName === "button" || tagName === "Button" || tagName === "IconButton"
  );
}

function hasAnyAttribute(opening, names, sourceFile) {
  return names.some((name) => getJsxAttribute(opening, name, sourceFile));
}

function hasAnyMeaningfulAttribute(opening, names, sourceFile) {
  return names.some((name) =>
    hasMeaningfulAttribute(opening, name, sourceFile),
  );
}

function hasMeaningfulAttribute(opening, name, sourceFile) {
  const attribute = getJsxAttribute(opening, name, sourceFile);
  if (!attribute) {
    return false;
  }
  return attributeIsMeaningful(attribute, sourceFile);
}

function hasTrueAttribute(opening, name, sourceFile) {
  const attribute = getJsxAttribute(opening, name, sourceFile);
  if (!attribute) {
    return false;
  }

  if (!attribute.initializer) {
    return true;
  }

  if (ts.isStringLiteral(attribute.initializer)) {
    return attribute.initializer.text === "true";
  }

  if (ts.isJsxExpression(attribute.initializer)) {
    const expression = unwrapExpression(attribute.initializer.expression);
    if (!expression) {
      return false;
    }

    if (expression.kind === ts.SyntaxKind.TrueKeyword) {
      return true;
    }

    if (ts.isStringLiteralLike(expression)) {
      return expression.text === "true";
    }
  }

  return true;
}

function hasFocusableTabIndex(opening, sourceFile) {
  const attribute = getJsxAttribute(opening, "tabIndex", sourceFile);
  if (!attribute || !attribute.initializer) {
    return false;
  }

  if (ts.isStringLiteral(attribute.initializer)) {
    const value = Number(attribute.initializer.text);
    return Number.isFinite(value) && value >= 0;
  }

  if (ts.isJsxExpression(attribute.initializer)) {
    const expression = unwrapExpression(attribute.initializer.expression);
    if (!expression) {
      return false;
    }

    if (ts.isNumericLiteral(expression)) {
      return Number(expression.text) >= 0;
    }

    if (
      ts.isPrefixUnaryExpression(expression) &&
      expression.operator === ts.SyntaxKind.MinusToken
    ) {
      return false;
    }
  }

  return true;
}

function attributeIsMeaningful(attribute, sourceFile) {
  if (!attribute.initializer) {
    return true;
  }

  if (ts.isStringLiteral(attribute.initializer)) {
    return attribute.initializer.text.trim().length > 0;
  }

  if (ts.isJsxExpression(attribute.initializer)) {
    const expression = unwrapExpression(attribute.initializer.expression);
    if (!expression) {
      return false;
    }

    if (ts.isStringLiteralLike(expression)) {
      return expression.text.trim().length > 0;
    }

    if (
      expression.kind === ts.SyntaxKind.FalseKeyword ||
      expression.kind === ts.SyntaxKind.NullKeyword ||
      expression.kind === ts.SyntaxKind.UndefinedKeyword
    ) {
      return false;
    }
  }

  return Boolean(sourceFile);
}

function staticAttributeText(opening, name, sourceFile) {
  const attribute = getJsxAttribute(opening, name, sourceFile);
  if (!attribute || !attribute.initializer) {
    return null;
  }

  if (ts.isStringLiteral(attribute.initializer)) {
    return attribute.initializer.text;
  }

  if (ts.isJsxExpression(attribute.initializer)) {
    const expression = unwrapExpression(attribute.initializer.expression);
    if (!expression) {
      return null;
    }

    if (ts.isStringLiteralLike(expression)) {
      return expression.text;
    }

    if (expression.kind === ts.SyntaxKind.TrueKeyword) {
      return "true";
    }

    if (expression.kind === ts.SyntaxKind.FalseKeyword) {
      return "false";
    }
  }

  return null;
}

function getJsxAttribute(opening, name, sourceFile) {
  return opening.attributes.properties.find(
    (property) =>
      ts.isJsxAttribute(property) && property.name.getText(sourceFile) === name,
  );
}

function classNameTokens(opening, sourceFile) {
  const attribute = getJsxAttribute(opening, "className", sourceFile);
  if (!attribute?.initializer) {
    return [];
  }

  const strings = [];
  collectStaticStrings(attribute.initializer, sourceFile, strings);
  return strings.flatMap((value) => value.split(/\s+/).filter(Boolean));
}

function collectStaticStrings(node, sourceFile, strings) {
  if (
    ts.isStringLiteralLike(node) ||
    ts.isNoSubstitutionTemplateLiteral(node)
  ) {
    strings.push(node.text);
    return;
  }

  if (ts.isTemplateExpression(node)) {
    strings.push(node.head.text);
    for (const span of node.templateSpans) {
      strings.push(span.literal.text);
    }
    return;
  }

  if (ts.isJsxExpression(node) && node.expression) {
    collectStaticStrings(node.expression, sourceFile, strings);
    return;
  }

  ts.forEachChild(node, (child) =>
    collectStaticStrings(child, sourceFile, strings),
  );
}

function jsxTagName(tagName, sourceFile) {
  return tagName.getText(sourceFile);
}

function isTranslationCall(node) {
  return (
    (ts.isIdentifier(node.expression) && node.expression.text === "t") ||
    (ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "t")
  );
}

function normalizeVisibleText(value) {
  return value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
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
  return ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
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
