import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExpandableSearch } from "@/components/ui/expandable-search";

afterEach(() => {
  cleanup();
});

describe("ExpandableSearch", () => {
  it("starts collapsed as a search button and expands into a field", () => {
    const onChange = vi.fn();
    render(
      <ExpandableSearch
        clearLabel="Clear search"
        label="Search branches"
        onChange={onChange}
        value=""
      />,
    );

    const root = screen.getByTestId("expandable-search");
    expect(root).not.toHaveAttribute("data-expanded");
    expect(
      screen.getByRole("button", { name: "Search branches" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Search branches" }));

    expect(root).toHaveAttribute("data-expanded", "true");
    const field = screen.getByRole("textbox", { name: "Search branches" });
    expect(field).toHaveFocus();
    expect(field).toHaveClass(
      "expandable-search-input",
      "outline-none",
      "focus-visible:outline-none",
      "focus-visible:ring-0",
    );
    expect(field).not.toHaveClass("focus-visible:ring-2");
  });

  it("stays expanded while it has a value and collapses when emptied and blurred", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ExpandableSearch
        clearLabel="Clear search"
        label="Search history"
        onChange={onChange}
        value=""
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Search history" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Search history" }), {
      target: { value: "main" },
    });
    expect(onChange).toHaveBeenCalledWith("main");

    rerender(
      <ExpandableSearch
        clearLabel="Clear search"
        label="Search history"
        onChange={onChange}
        value="main"
      />,
    );
    fireEvent.blur(screen.getByRole("textbox", { name: "Search history" }));
    expect(
      screen.getByRole("textbox", { name: "Search history" }),
    ).toBeInTheDocument();

    rerender(
      <ExpandableSearch
        clearLabel="Clear search"
        label="Search history"
        onChange={onChange}
        value=""
      />,
    );
    fireEvent.blur(screen.getByRole("textbox", { name: "Search history" }));
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Search history" }),
    ).toBeInTheDocument();
  });

  it("clears the query from the clear button", () => {
    const onChange = vi.fn();
    render(
      <ExpandableSearch
        clearLabel="Clear search"
        label="Search stashes"
        onChange={onChange}
        value="auto"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onChange).toHaveBeenCalledWith("");
  });
});
