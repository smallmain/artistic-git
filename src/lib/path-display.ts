export function normalizeDisplayPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/{2,}/g, "/");

  if (normalized === "/") {
    return normalized;
  }

  return normalized.replace(/\/+$/g, "");
}
