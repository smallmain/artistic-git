import * as React from "react";

import { useLanguage } from "@/i18n/LanguageProvider";

import type { SupportedLanguage } from "./resources";

type DateInput = Date | number | string;

const fileSizeUnits: Intl.NumberFormatOptions["unit"][] = [
  "byte",
  "kilobyte",
  "megabyte",
  "gigabyte",
  "terabyte",
];

const relativeTimeUnits = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
  ["second", 1],
] as const satisfies ReadonlyArray<
  readonly [Intl.RelativeTimeFormatUnit, number]
>;

export interface LocalizedFormatters {
  formatDate: (
    value: DateInput,
    options?: Intl.DateTimeFormatOptions,
  ) => string;
  formatFileSize: (bytes: number) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatRelativeTime: (value: DateInput, now?: DateInput) => string;
}

export function formatDate(
  value: DateInput,
  language: SupportedLanguage,
  options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
  },
): string {
  return new Intl.DateTimeFormat(language, options).format(toDate(value));
}

export function formatNumber(
  value: number,
  language: SupportedLanguage,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(language, options).format(value);
}

export function formatFileSize(
  bytes: number,
  language: SupportedLanguage,
): string {
  const safeBytes = Number.isFinite(bytes) ? bytes : 0;
  const sign = safeBytes < 0 ? -1 : 1;
  let value = Math.abs(safeBytes);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < fileSizeUnits.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return new Intl.NumberFormat(language, {
    maximumFractionDigits: unitIndex === 0 ? 0 : 1,
    style: "unit",
    unit: fileSizeUnits[unitIndex],
    unitDisplay: "short",
  }).format(value * sign);
}

export function formatRelativeTime(
  value: DateInput,
  language: SupportedLanguage,
  now: DateInput = Date.now(),
): string {
  const targetTime = toDate(value).getTime();
  const nowTime = toDate(now).getTime();
  const deltaSeconds = Math.round((targetTime - nowTime) / 1000);
  const absoluteDelta = Math.abs(deltaSeconds);
  const formatter = new Intl.RelativeTimeFormat(language, {
    numeric: "auto",
  });

  for (const [unit, secondsPerUnit] of relativeTimeUnits) {
    if (absoluteDelta >= secondsPerUnit || unit === "second") {
      return formatter.format(Math.round(deltaSeconds / secondsPerUnit), unit);
    }
  }

  return formatter.format(0, "second");
}

export function useLocalizedFormatters(): LocalizedFormatters {
  const { resolvedLanguage } = useLanguage();

  return React.useMemo(
    () => ({
      formatDate: (value, options) =>
        formatDate(value, resolvedLanguage, options),
      formatFileSize: (bytes) => formatFileSize(bytes, resolvedLanguage),
      formatNumber: (value, options) =>
        formatNumber(value, resolvedLanguage, options),
      formatRelativeTime: (value, now) =>
        formatRelativeTime(value, resolvedLanguage, now),
    }),
    [resolvedLanguage],
  );
}

function toDate(value: DateInput): Date {
  return value instanceof Date ? value : new Date(value);
}
