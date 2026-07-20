import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FloatingPanel } from "./floating-panel";
import {
  DialogLayerContext,
  dialogOpenedEventName,
  useModalLayer,
} from "@/lib/dialog-layer";

function MenuFixture({ onClose }: { onClose: () => void }) {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = React.useState<HTMLButtonElement | null>(null);

  React.useLayoutEffect(() => {
    setAnchor(triggerRef.current);
  }, []);

  return (
    <>
      <button onPointerDown={(event) => event.stopPropagation()} type="button">
        Outside action
      </button>
      <button ref={triggerRef} type="button">
        Open menu
      </button>
      {anchor ? (
        <FloatingPanel
          anchor={anchor}
          aria-label="Actions"
          onClose={onClose}
          role="menu"
        >
          <button role="menuitem" type="button">
            First
          </button>
          <button disabled role="menuitem" type="button">
            Disabled
          </button>
          <button role="menuitem" type="button">
            Last
          </button>
        </FloatingPanel>
      ) : null}
    </>
  );
}

function ModalFixture({ onClose }: { onClose: () => void }) {
  const dialogRef = React.useRef<HTMLDivElement>(null);
  const dialogId = useModalLayer(dialogRef);

  return (
    <DialogLayerContext.Provider value={dialogId}>
      <div
        ref={dialogRef}
        aria-label="Settings"
        aria-modal="true"
        role="dialog"
        tabIndex={-1}
      >
        <button onClick={onClose} type="button">
          Close settings
        </button>
      </div>
    </DialogLayerContext.Provider>
  );
}

function MenuToModalFixture() {
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = React.useState<HTMLButtonElement | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [modalOpen, setModalOpen] = React.useState(false);

  React.useLayoutEffect(() => {
    setAnchor(triggerRef.current);
  }, []);

  return (
    <>
      <button ref={triggerRef} onClick={() => setMenuOpen(true)} type="button">
        Open actions
      </button>
      {menuOpen && anchor ? (
        <FloatingPanel
          anchor={anchor}
          aria-label="Actions"
          onClose={() => setMenuOpen(false)}
          role="menu"
        >
          <button
            onClick={() => setModalOpen(true)}
            role="menuitem"
            type="button"
          >
            Open settings
          </button>
        </FloatingPanel>
      ) : null}
      {modalOpen ? <ModalFixture onClose={() => setModalOpen(false)} /> : null}
    </>
  );
}

afterEach(cleanup);

describe("FloatingPanel", () => {
  it("focuses menu items, supports arrow navigation, and closes with Escape", () => {
    const onClose = vi.fn();
    render(<MenuFixture onClose={onClose} />);

    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Last" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "End" });
    expect(screen.getByRole("menuitem", { name: "Last" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes when the user clicks outside", () => {
    const onClose = vi.fn();
    render(<MenuFixture onClose={onClose} />);

    fireEvent.pointerDown(document.body);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes before an outside component can stop event propagation", () => {
    const onClose = vi.fn();
    render(<MenuFixture onClose={onClose} />);

    const menu = screen.getByRole("menu", { name: "Actions" });
    expect(menu.parentElement).toBe(document.body);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Outside action" }),
    );

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes a background panel when a modal dialog opens", () => {
    const onClose = vi.fn();
    render(<MenuFixture onClose={onClose} />);

    window.dispatchEvent(
      new CustomEvent(dialogOpenedEventName, {
        detail: { dialogId: "new-modal" },
      }),
    );

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("returns focus to the panel trigger after a modal closes", () => {
    render(<MenuToModalFixture />);

    const trigger = screen.getByRole("button", { name: "Open actions" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Open settings" }));

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: "Settings" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));

    expect(trigger).toHaveFocus();
  });
});
