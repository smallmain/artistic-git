import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BranchSelect } from "./branch-select";
import { dialogOpenedEventName } from "@/lib/dialog-layer";

afterEach(cleanup);

describe("BranchSelect", () => {
  it("keeps the DOM bounded while searching and selecting among 5,000 branches", async () => {
    const onChange = vi.fn();
    const options = Array.from({ length: 5_000 }, (_, index) => ({
      label: `feature/branch-${String(index).padStart(4, "0")}`,
      value: `feature/branch-${String(index).padStart(4, "0")}`,
    }));

    render(
      <BranchSelect
        label="Starting branch"
        noResultsLabel="No matching items"
        onChange={onChange}
        options={options}
        searchLabel="Search branches"
        value={options[0].value}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Starting branch" }));

    const initiallyRenderedOptions = screen.getAllByRole("option");
    expect(initiallyRenderedOptions.length).toBeLessThan(50);
    expect(initiallyRenderedOptions[0]).toHaveAttribute("aria-setsize", "5000");

    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search branches" }),
      {
        target: { value: "branch-4999" },
      },
    );

    const distantBranch = await screen.findByRole("option", {
      name: "feature/branch-4999",
    });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(distantBranch);

    expect(onChange).toHaveBeenCalledWith("feature/branch-4999");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("supports keyboard navigation and selection", async () => {
    const onChange = vi.fn();
    render(
      <BranchSelect
        label="Branch to clone"
        noResultsLabel="No matching items"
        onChange={onChange}
        options={[
          { label: "main (default)", value: "main" },
          { label: "develop", value: "develop" },
        ]}
        searchLabel="Search branches"
        value="main"
      />,
    );

    fireEvent.keyDown(
      screen.getByRole("combobox", { name: "Branch to clone" }),
      { key: "ArrowDown" },
    );
    const search = await screen.findByRole("searchbox", {
      name: "Search branches",
    });
    await waitFor(() => expect(search).toHaveFocus());

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onChange).toHaveBeenCalledWith("develop");
  });

  it("closes an open list when another modal dialog opens", () => {
    render(
      <BranchSelect
        label="Branch to clone"
        noResultsLabel="No matching items"
        onChange={vi.fn()}
        options={[{ label: "main", value: "main" }]}
        searchLabel="Search branches"
        value="main"
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Branch to clone" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(dialogOpenedEventName, {
          detail: { dialogId: "error-dialog" },
        }),
      );
    });

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Branch to clone" }),
    ).toHaveFocus();
  });

  it("closes when an outside control stops pointer event propagation", () => {
    render(
      <>
        <button
          onPointerDown={(event) => event.stopPropagation()}
          type="button"
        >
          Outside action
        </button>
        <BranchSelect
          label="Branch to clone"
          noResultsLabel="No matching items"
          onChange={vi.fn()}
          options={[{ label: "main", value: "main" }]}
          searchLabel="Search branches"
          value="main"
        />
      </>,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Branch to clone" }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Outside action" }),
    );

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
