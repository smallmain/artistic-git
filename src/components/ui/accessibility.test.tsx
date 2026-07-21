import { fireEvent, render, screen } from "@testing-library/react";
import { Settings } from "lucide-react";
import { describe, expect, it, vi } from "vitest";

import { DismissiblePanel } from "@/components/ui/dismissible-panel";
import { IconButton } from "@/components/ui/icon-button";
import { TruncatedText } from "@/components/ui/truncated-text";

describe("common UI accessibility", () => {
  it("requires icon buttons to expose an aria label and tooltip", () => {
    render(
      <IconButton label="Open settings" tooltip="Open settings">
        <Settings className="size-4" aria-hidden="true" />
      </IconButton>,
    );

    expect(
      screen.getByRole("button", { name: "Open settings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tooltip", { name: "Open settings" }),
    ).toBeInTheDocument();
  });

  it("renders truncated normalized text with the full value in a tooltip", () => {
    render(
      <TruncatedText
        normalizePath
        text="C:\\repo\\assets\\characters\\hero.png"
      />,
    );

    const labels = screen.getAllByText("C:/repo/assets/characters/hero.png");
    expect(labels).toHaveLength(2);
    const visibleLabel = labels.find(
      (node) => node.getAttribute("role") !== "tooltip",
    );
    expect(visibleLabel).toBeDefined();
    expect(visibleLabel).toHaveClass("truncate", "max-w-full", "min-w-0");
    expect(visibleLabel?.parentElement).toHaveClass(
      "block",
      "w-full",
      "min-w-0",
      "max-w-full",
    );
    expect(
      screen.getByRole("tooltip", {
        name: "C:/repo/assets/characters/hero.png",
      }),
    ).toBeInTheDocument();
  });

  it("closes panels with Escape", () => {
    const onOpenChange = vi.fn();

    render(
      <DismissiblePanel onOpenChange={onOpenChange} open title="Details panel">
        Panel content
      </DismissiblePanel>,
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
