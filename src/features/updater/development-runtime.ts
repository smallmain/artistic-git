export function isDevelopmentRuntime(): boolean {
  return import.meta.env.DEV;
}
