import * as React from "react";
import { createPortal } from "react-dom";

import {
  DialogLayerContext,
  dialogOpenedEventName,
  type DialogOpenedEventDetail,
} from "@/lib/dialog-layer";
import { cn } from "@/lib/utils";

export type FloatingPanelAnchor =
  HTMLElement | { returnFocusTo?: HTMLElement; x: number; y: number };

interface FloatingPanelProps {
  anchor: FloatingPanelAnchor;
  "aria-label"?: string;
  "aria-modal"?: boolean;
  children: React.ReactNode;
  className?: string;
  gap?: number;
  onClose: () => void;
  role?: React.AriaRole;
}

const focusableSelector = [
  "[data-autofocus]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[href]:not([aria-disabled="true"])',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function FloatingPanel({
  anchor,
  "aria-label": ariaLabel,
  "aria-modal": ariaModal,
  children,
  className,
  gap = 4,
  onClose,
  role,
}: FloatingPanelProps) {
  const dialogOwnerId = React.useContext(DialogLayerContext);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const onCloseRef = React.useRef(onClose);
  const restoreFocusRef = React.useRef(true);
  const [position, setPosition] = React.useState({ left: 8, top: 8 });

  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const updatePosition = React.useCallback(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }
    const viewportPadding = 8;
    const panelRect = panel.getBoundingClientRect();
    const panelWidth = panelRect.width || panel.offsetWidth;
    const panelHeight = panelRect.height || panel.offsetHeight;
    const anchorRect =
      anchor instanceof HTMLElement
        ? anchor.getBoundingClientRect()
        : {
            bottom: anchor.y,
            left: anchor.x,
            right: anchor.x,
            top: anchor.y,
          };
    const availableBelow = window.innerHeight - anchorRect.bottom;
    const canFitAbove = anchorRect.top - gap - panelHeight >= viewportPadding;
    const top =
      availableBelow < panelHeight + gap && canFitAbove
        ? anchorRect.top - panelHeight - gap
        : anchorRect.bottom + gap;
    const maxLeft = Math.max(
      viewportPadding,
      window.innerWidth - panelWidth - viewportPadding,
    );
    const maxTop = Math.max(
      viewportPadding,
      window.innerHeight - panelHeight - viewportPadding,
    );
    setPosition({
      left: Math.min(Math.max(viewportPadding, anchorRect.left), maxLeft),
      top: Math.min(Math.max(viewportPadding, top), maxTop),
    });
  }, [anchor, gap]);

  React.useLayoutEffect(() => {
    updatePosition();
    panelRef.current?.querySelector<HTMLElement>(focusableSelector)?.focus();
  }, [updatePosition]);

  React.useEffect(() => {
    const returnFocusTo =
      anchor instanceof HTMLElement
        ? anchor
        : (anchor.returnFocusTo ??
          (document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null));
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (
        panelRef.current?.contains(target) ||
        (anchor instanceof HTMLElement && anchor.contains(target))
      ) {
        return;
      }
      onCloseRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (
        role !== "menu" ||
        !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
      ) {
        return;
      }
      const items = Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])',
        ) ?? [],
      );
      if (items.length === 0) {
        return;
      }
      event.preventDefault();
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      if (event.key === "Home") {
        items[0].focus();
      } else if (event.key === "End") {
        items.at(-1)?.focus();
      } else {
        const direction = event.key === "ArrowDown" ? 1 : -1;
        const nextIndex =
          currentIndex < 0
            ? direction > 0
              ? 0
              : items.length - 1
            : (currentIndex + direction + items.length) % items.length;
        items[nextIndex].focus();
      }
    };
    const handleViewportChange = () => updatePosition();
    const handleDialogOpened = (event: Event) => {
      const openedDialogId = (event as CustomEvent<DialogOpenedEventDetail>)
        .detail?.dialogId;
      if (openedDialogId && openedDialogId !== dialogOwnerId) {
        if (returnFocusTo?.isConnected) {
          returnFocusTo.focus();
        }
        restoreFocusRef.current = false;
        onCloseRef.current();
      }
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener(dialogOpenedEventName, handleDialogOpened);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener(dialogOpenedEventName, handleDialogOpened);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
      if (restoreFocusRef.current && returnFocusTo?.isConnected) {
        returnFocusTo.focus();
      }
    };
  }, [anchor, dialogOwnerId, role, updatePosition]);

  return createPortal(
    <div
      aria-label={ariaLabel}
      aria-modal={ariaModal}
      className={cn(
        "fixed z-[80] rounded-md border bg-card text-card-foreground shadow-floating",
        className,
      )}
      data-dialog-portal="true"
      data-dialog-owner={dialogOwnerId ?? undefined}
      ref={panelRef}
      role={role}
      style={position}
    >
      {children}
    </div>,
    document.body,
  );
}
