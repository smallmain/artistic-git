import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AppProviders } from "@/AppProviders";
import {
  formatDate,
  formatFileSize,
  formatNumber,
  formatRelativeTime,
  useLocalizedFormatters,
} from "@/i18n/format";
import { createI18n } from "@/i18n/i18n";
import { useLanguage } from "@/i18n/LanguageProvider";
import { createAppQueryClient } from "@/lib/query/client";

describe("localized formatters", () => {
  it("formats dates, relative time, numbers, and file sizes in English", () => {
    const date = "2026-07-07T04:30:00Z";
    const now = "2026-07-07T06:30:00Z";

    expect(
      formatDate(date, "en", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }),
    ).toBe("Jul 7, 2026, 4:30 AM");
    expect(formatRelativeTime(date, "en", now)).toBe("2 hours ago");
    expect(formatNumber(12345.6, "en", { maximumFractionDigits: 1 })).toBe(
      "12,345.6",
    );
    expect(formatFileSize(1_572_864, "en")).toBe("1.5 MB");
  });

  it("formats dates, relative time, numbers, and file sizes in Chinese", () => {
    const date = "2026-07-07T04:30:00Z";
    const now = "2026-07-07T06:30:00Z";

    expect(
      formatDate(date, "zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      }),
    ).toBe("2026年7月7日 04:30");
    expect(formatRelativeTime(date, "zh-CN", now)).toBe("2小时前");
    expect(formatNumber(12345.6, "zh-CN", { maximumFractionDigits: 1 })).toBe(
      "12,345.6",
    );
    expect(formatFileSize(1_572_864, "zh-CN")).toBe("1.5 MB");
  });

  it("follows the current app language preference", () => {
    render(
      <AppProviders
        i18n={createI18n("en")}
        initialLanguagePreference="en"
        initialThemePreference="light"
        queryClient={createAppQueryClient()}
      >
        <FormatterProbe />
      </AppProviders>,
    );

    expect(screen.getByLabelText("relative")).toHaveTextContent("2 hours ago");

    fireEvent.click(screen.getByRole("button", { name: "zh-CN" }));

    expect(screen.getByLabelText("relative")).toHaveTextContent("2小时前");
  });
});

function FormatterProbe() {
  const { setLanguagePreference } = useLanguage();
  const formatters = useLocalizedFormatters();

  return (
    <>
      <output aria-label="relative">
        {formatters.formatRelativeTime(
          "2026-07-07T04:30:00Z",
          "2026-07-07T06:30:00Z",
        )}
      </output>
      <button
        onClick={() => {
          setLanguagePreference("zh-CN");
        }}
        type="button"
      >
        zh-CN
      </button>
    </>
  );
}
