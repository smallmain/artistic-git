import * as React from "react";

export const DialogLayerContext = React.createContext<string | null>(null);
export const dialogOpenedEventName = "artistic-git:dialog-opened";
export const dialogOwnerAttribute = "data-dialog-owner";

export interface DialogOpenedEventDetail {
  dialogId: string;
}

interface ModalLayerEntry {
  container: HTMLElement;
  dialogId: string;
}

interface ModalLayerOptions {
  onEscape?: () => void;
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
}

const modalLayerStack: ModalLayerEntry[] = [];
const focusableSelector = [
  'button:not([disabled]):not([tabindex="-1"])',
  "[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function useModalLayer(
  containerRef: React.RefObject<HTMLElement | null>,
  { onEscape, restoreFocusRef }: ModalLayerOptions = {},
): string {
  const dialogId = React.useId();
  const onEscapeRef = React.useRef(onEscape);

  React.useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    window.dispatchEvent(
      new CustomEvent<DialogOpenedEventDetail>(dialogOpenedEventName, {
        detail: { dialogId },
      }),
    );
    const previouslyFocused = document.activeElement;
    const requestedFocusTarget = restoreFocusRef?.current ?? null;
    modalLayerStack.push({ container, dialogId });
    container.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTopModalLayer(dialogId)) {
        return;
      }
      if (event.key === "Escape" && onEscapeRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }

      const focusable = modalFocusableElements(container, dialogId);
      event.preventDefault();
      if (focusable.length === 0) {
        container.focus();
        return;
      }
      const currentIndex = focusable.indexOf(
        document.activeElement as HTMLElement,
      );
      const direction = event.shiftKey ? -1 : 1;
      const nextIndex =
        currentIndex < 0
          ? direction > 0
            ? 0
            : focusable.length - 1
          : (currentIndex + direction + focusable.length) % focusable.length;
      focusable[nextIndex].focus();
    };

    const keepFocusInTopLayer = (event: FocusEvent) => {
      if (
        !isTopModalLayer(dialogId) ||
        container.contains(event.target as Node) ||
        portalBelongsToDialog(event.target, dialogId)
      ) {
        return;
      }
      (modalFocusableElements(container, dialogId)[0] ?? container).focus();
    };

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", keepFocusInTopLayer);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", keepFocusInTopLayer);
      const index = modalLayerStack.findLastIndex(
        (entry) => entry.dialogId === dialogId,
      );
      if (index >= 0) {
        modalLayerStack.splice(index, 1);
      }
      const focusTarget =
        requestedFocusTarget?.isConnected === true
          ? requestedFocusTarget
          : previouslyFocused instanceof HTMLElement &&
              previouslyFocused.isConnected
            ? previouslyFocused
            : null;
      if (focusTarget) {
        focusTarget.focus();
        if (document.activeElement !== focusTarget) {
          queueMicrotask(() => {
            if (modalLayerStack.length === 0 && focusTarget.isConnected) {
              focusTarget.focus();
            }
          });
        }
      } else {
        const previousLayer = modalLayerStack.at(-1);
        if (previousLayer) {
          (
            modalFocusableElements(
              previousLayer.container,
              previousLayer.dialogId,
            )[0] ?? previousLayer.container
          ).focus();
        }
      }
    };
  }, [containerRef, dialogId, restoreFocusRef]);

  return dialogId;
}

export function hasOpenModalLayer(): boolean {
  return modalLayerStack.length > 0;
}

function isTopModalLayer(dialogId: string): boolean {
  return modalLayerStack.at(-1)?.dialogId === dialogId;
}

function modalFocusableElements(
  container: HTMLElement,
  dialogId: string,
): HTMLElement[] {
  const elements = Array.from(
    container.querySelectorAll<HTMLElement>(focusableSelector),
  );
  for (const portal of document.querySelectorAll<HTMLElement>(
    '[data-dialog-portal="true"]',
  )) {
    if (portal.getAttribute(dialogOwnerAttribute) === dialogId) {
      elements.push(...portal.querySelectorAll<HTMLElement>(focusableSelector));
    }
  }
  return elements.filter((element) => element.isConnected);
}

function portalBelongsToDialog(target: EventTarget | null, dialogId: string) {
  return (
    target instanceof Element &&
    target
      .closest('[data-dialog-portal="true"]')
      ?.getAttribute(dialogOwnerAttribute) === dialogId
  );
}
