export type LineDiffRowType = "unchanged" | "added" | "removed" | "modified";

export interface LineDiffRow {
  newLineNumber?: number;
  newText?: string;
  oldLineNumber?: number;
  oldText?: string;
  type: LineDiffRowType;
}

type DiffOperation =
  | { line: string; type: "unchanged" }
  | { line: string; type: "added" }
  | { line: string; type: "removed" };

const maxExactCells = 1_000_000;

export function buildLineDiffRows(oldText = "", newText = ""): LineDiffRow[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  if (oldLines.length * newLines.length > maxExactCells) {
    return buildFallbackRows(oldLines, newLines);
  }

  return pairOperations(buildOperations(oldLines, newLines));
}

function splitLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  return text.replace(/\n$/, "").split("\n");
}

function buildFallbackRows(oldLines: string[], newLines: string[]): LineDiffRow[] {
  const rows: LineDiffRow[] = [];
  const maxLength = Math.max(oldLines.length, newLines.length);

  for (let index = 0; index < maxLength; index += 1) {
    const oldLine = oldLines[index];
    const newLine = newLines[index];

    if (oldLine === newLine) {
      rows.push({
        newLineNumber: index + 1,
        newText: newLine,
        oldLineNumber: index + 1,
        oldText: oldLine,
        type: "unchanged",
      });
    } else if (oldLine === undefined) {
      rows.push({
        newLineNumber: index + 1,
        newText: newLine,
        type: "added",
      });
    } else if (newLine === undefined) {
      rows.push({
        oldLineNumber: index + 1,
        oldText: oldLine,
        type: "removed",
      });
    } else {
      rows.push({
        newLineNumber: index + 1,
        newText: newLine,
        oldLineNumber: index + 1,
        oldText: oldLine,
        type: "modified",
      });
    }
  }

  return rows;
}

function buildOperations(oldLines: string[], newLines: string[]): DiffOperation[] {
  const width = newLines.length + 1;
  const table = new Uint32Array((oldLines.length + 1) * width);

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const offset = oldIndex * width + newIndex;
      table[offset] =
        oldLines[oldIndex] === newLines[newIndex]
          ? table[(oldIndex + 1) * width + newIndex + 1] + 1
          : Math.max(
              table[(oldIndex + 1) * width + newIndex],
              table[oldIndex * width + newIndex + 1],
            );
    }
  }

  const operations: DiffOperation[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      operations.push({ line: oldLines[oldIndex], type: "unchanged" });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      table[(oldIndex + 1) * width + newIndex] >=
      table[oldIndex * width + newIndex + 1]
    ) {
      operations.push({ line: oldLines[oldIndex], type: "removed" });
      oldIndex += 1;
    } else {
      operations.push({ line: newLines[newIndex], type: "added" });
      newIndex += 1;
    }
  }

  while (oldIndex < oldLines.length) {
    operations.push({ line: oldLines[oldIndex], type: "removed" });
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    operations.push({ line: newLines[newIndex], type: "added" });
    newIndex += 1;
  }

  return operations;
}

function pairOperations(operations: DiffOperation[]): LineDiffRow[] {
  const rows: LineDiffRow[] = [];
  let oldLineNumber = 1;
  let newLineNumber = 1;

  for (let index = 0; index < operations.length; index += 1) {
    const operation = operations[index];

    if (operation.type === "unchanged") {
      rows.push({
        newLineNumber,
        newText: operation.line,
        oldLineNumber,
        oldText: operation.line,
        type: "unchanged",
      });
      oldLineNumber += 1;
      newLineNumber += 1;
      continue;
    }

    if (operation.type === "removed" && operations[index + 1]?.type === "added") {
      const nextOperation = operations[index + 1];
      rows.push({
        newLineNumber,
        newText: nextOperation.line,
        oldLineNumber,
        oldText: operation.line,
        type: "modified",
      });
      oldLineNumber += 1;
      newLineNumber += 1;
      index += 1;
      continue;
    }

    if (operation.type === "removed") {
      rows.push({
        oldLineNumber,
        oldText: operation.line,
        type: "removed",
      });
      oldLineNumber += 1;
    } else {
      rows.push({
        newLineNumber,
        newText: operation.line,
        type: "added",
      });
      newLineNumber += 1;
    }
  }

  return rows;
}
