import { Check, ChevronDown, GitBranch, Search } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";

import { OverlayScrollArea } from "@/components/ui/overlay-scroll-area";
import {
  DialogLayerContext,
  dialogOpenedEventName,
  type DialogOpenedEventDetail,
} from "@/lib/dialog-layer";
import { cn } from "@/lib/utils";

const optionHeight = 36;
const listHeight = 216;
const optionOverscan = 4;

export interface BranchSelectOption {
  label: string;
  value: string;
}

interface BranchSelectProps {
  className?: string;
  disabled?: boolean;
  id?: string;
  label: string;
  noResultsLabel: string;
  onChange: (value: string) => void;
  options: BranchSelectOption[];
  searchLabel: string;
  "data-testid"?: string;
  value: string;
}

interface PopupPosition {
  left: number;
  top: number;
  width: number;
}

export function BranchSelect({
  className,
  disabled = false,
  id,
  label,
  noResultsLabel,
  onChange,
  options,
  searchLabel,
  "data-testid": testId,
  value,
}: BranchSelectProps) {
  const dialogOwnerId = React.useContext(DialogLayerContext);
  const generatedId = React.useId();
  const controlId = id ?? `${generatedId}-control`;
  const labelId = `${generatedId}-label`;
  const listboxId = `${generatedId}-listbox`;
  const rootRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const popupRef = React.useRef<HTMLDivElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const initialScrollTopRef = React.useRef(0);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [popupPosition, setPopupPosition] = React.useState<PopupPosition>({
    left: 8,
    top: 8,
    width: 240,
  });

  const filteredOptions = React.useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      return options;
    }

    return options.filter(
      (option) =>
        option.value.toLocaleLowerCase().includes(normalizedQuery) ||
        option.label.toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [options, query]);
  const selectedOption = options.find((option) => option.value === value);
  const visibleOptionCount = Math.ceil(listHeight / optionHeight);
  const requestedStart = Math.floor(scrollTop / optionHeight) - optionOverscan;
  const visibleStart = Math.min(
    Math.max(0, requestedStart),
    Math.max(
      0,
      filteredOptions.length - visibleOptionCount - optionOverscan * 2,
    ),
  );
  const visibleEnd = Math.min(
    filteredOptions.length,
    visibleStart + visibleOptionCount + optionOverscan * 2,
  );
  const visibleOptions = filteredOptions.slice(visibleStart, visibleEnd);
  const effectiveActiveIndex = Math.min(
    Math.max(0, activeIndex),
    Math.max(0, filteredOptions.length - 1),
  );

  const updatePopupPosition = React.useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const popupHeight = 278;
    const viewportPadding = 8;
    const width = Math.max(
      0,
      Math.min(
        Math.max(rect.width, 240),
        window.innerWidth - viewportPadding * 2,
      ),
    );
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
    );
    const top =
      window.innerHeight - rect.bottom >= popupHeight || rect.top < popupHeight
        ? Math.min(
            rect.bottom + 4,
            window.innerHeight - popupHeight - viewportPadding,
          )
        : Math.max(viewportPadding, rect.top - popupHeight - 4);

    setPopupPosition({ left, top: Math.max(viewportPadding, top), width });
  }, []);

  const scrollToOption = React.useCallback((index: number) => {
    const list = listRef.current;
    if (!list) {
      return;
    }

    const optionTop = index * optionHeight;
    const optionBottom = optionTop + optionHeight;
    let nextScrollTop = list.scrollTop;
    if (optionTop < list.scrollTop) {
      nextScrollTop = optionTop;
    } else if (optionBottom > list.scrollTop + listHeight) {
      nextScrollTop = optionBottom - listHeight;
    }
    if (nextScrollTop !== list.scrollTop) {
      list.scrollTop = nextScrollTop;
      setScrollTop(nextScrollTop);
    }
  }, []);

  const closeAndFocusTrigger = React.useCallback(() => {
    setOpen(false);
    setQuery("");
    setScrollTop(0);
    triggerRef.current?.focus();
  }, []);

  const chooseOption = React.useCallback(
    (option: BranchSelectOption) => {
      onChange(option.value);
      closeAndFocusTrigger();
    },
    [closeAndFocusTrigger, onChange],
  );

  const openSelect = React.useCallback(() => {
    const selectedIndex = options.findIndex((option) => option.value === value);
    const nextActiveIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const nextScrollTop = Math.max(
      0,
      (nextActiveIndex + 1) * optionHeight - listHeight,
    );
    setQuery("");
    setActiveIndex(nextActiveIndex);
    initialScrollTopRef.current = nextScrollTop;
    setScrollTop(nextScrollTop);
    setOpen(true);
  }, [options, value]);

  React.useLayoutEffect(() => {
    if (!open) {
      return;
    }

    updatePopupPosition();
    if (listRef.current) {
      listRef.current.scrollTop = initialScrollTopRef.current;
    }
  }, [open, updatePopupPosition]);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    const handleResize = () => updatePopupPosition();
    const handleScroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        popupRef.current?.contains(event.target)
      ) {
        return;
      }
      updatePopupPosition();
    };
    window.addEventListener("resize", handleResize);
    window.addEventListener("scroll", handleScroll, true);
    return () => {
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("scroll", handleScroll, true);
    };
  }, [open, updatePopupPosition]);

  React.useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        !rootRef.current?.contains(target) &&
        !popupRef.current?.contains(target)
      ) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [open]);

  React.useEffect(() => {
    if (!open) {
      return;
    }
    const handleDialogOpened = (event: Event) => {
      const openedDialogId = (event as CustomEvent<DialogOpenedEventDetail>)
        .detail?.dialogId;
      if (openedDialogId && openedDialogId !== dialogOwnerId) {
        closeAndFocusTrigger();
      }
    };
    window.addEventListener(dialogOpenedEventName, handleDialogOpened);
    return () =>
      window.removeEventListener(dialogOpenedEventName, handleDialogOpened);
  }, [closeAndFocusTrigger, dialogOwnerId, open]);

  const moveActiveOption = (nextIndex: number) => {
    if (filteredOptions.length === 0) {
      return;
    }

    const boundedIndex = Math.min(
      filteredOptions.length - 1,
      Math.max(0, nextIndex),
    );
    setActiveIndex(boundedIndex);
    scrollToOption(boundedIndex);
  };

  return (
    <div className={cn("grid min-w-0 gap-1 text-sm", className)} ref={rootRef}>
      <span className="font-medium" id={labelId}>
        {label}
      </span>
      <button
        aria-controls={open ? listboxId : undefined}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-labelledby={labelId}
        className="flex h-9 min-w-0 items-center gap-2 rounded-md border bg-background px-3 text-left text-sm font-normal outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        data-testid={testId}
        disabled={disabled}
        id={controlId}
        onClick={() => {
          if (open) {
            setOpen(false);
            setQuery("");
          } else {
            openSelect();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openSelect();
          }
        }}
        ref={triggerRef}
        role="combobox"
        title={selectedOption?.label ?? value}
        type="button"
        value={value}
      >
        <GitBranch
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate">
          {selectedOption?.label ?? value}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
        />
      </button>

      {open
        ? createPortal(
            <div
              className="fixed z-[70] grid h-[278px] gap-2 rounded-md border bg-card p-2 text-card-foreground shadow-floating"
              data-dialog-portal="true"
              data-dialog-owner={dialogOwnerId ?? undefined}
              ref={popupRef}
              style={popupPosition}
            >
              <label className="relative block">
                <span className="sr-only">{searchLabel}</span>
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                />
                <input
                  aria-autocomplete="list"
                  aria-controls={listboxId}
                  aria-label={searchLabel}
                  autoFocus
                  className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(event) => {
                    setQuery(event.currentTarget.value);
                    setActiveIndex(0);
                    if (listRef.current) {
                      listRef.current.scrollTop = 0;
                    }
                    setScrollTop(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      moveActiveOption(effectiveActiveIndex + 1);
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      moveActiveOption(effectiveActiveIndex - 1);
                    } else if (event.key === "Home") {
                      event.preventDefault();
                      moveActiveOption(0);
                    } else if (event.key === "End") {
                      event.preventDefault();
                      moveActiveOption(filteredOptions.length - 1);
                    } else if (event.key === "Enter") {
                      const activeOption =
                        filteredOptions[effectiveActiveIndex];
                      if (activeOption) {
                        event.preventDefault();
                        chooseOption(activeOption);
                      }
                    } else if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      closeAndFocusTrigger();
                    }
                  }}
                  placeholder={searchLabel}
                  role="searchbox"
                  value={query}
                />
              </label>
              <OverlayScrollArea
                aria-activedescendant={
                  filteredOptions[effectiveActiveIndex]
                    ? `${listboxId}-option-${effectiveActiveIndex}`
                    : undefined
                }
                aria-label={label}
                className="h-[216px] rounded-md bg-background"
                id={listboxId}
                onScroll={(event) =>
                  setScrollTop(event.currentTarget.scrollTop)
                }
                ref={listRef}
                role="listbox"
              >
                {filteredOptions.length === 0 ? (
                  <div className="flex h-full items-center justify-center px-3 text-sm text-muted-foreground">
                    {noResultsLabel}
                  </div>
                ) : (
                  <div
                    className="relative"
                    style={{ height: filteredOptions.length * optionHeight }}
                  >
                    {visibleOptions.map((option, offset) => {
                      const index = visibleStart + offset;
                      const selected = option.value === value;
                      const active = index === effectiveActiveIndex;
                      return (
                        <button
                          aria-posinset={index + 1}
                          aria-selected={selected}
                          aria-setsize={filteredOptions.length}
                          className={cn(
                            "absolute left-0 right-0 flex h-9 min-w-0 items-center gap-2 rounded-sm px-2 text-left text-sm outline-none hover:bg-accent",
                            active && "bg-accent",
                          )}
                          id={`${listboxId}-option-${index}`}
                          key={option.value}
                          onClick={() => chooseOption(option)}
                          onMouseDown={(event) => event.preventDefault()}
                          role="option"
                          style={{ top: index * optionHeight }}
                          tabIndex={-1}
                          title={option.label}
                          type="button"
                        >
                          <Check
                            aria-hidden="true"
                            className={cn(
                              "size-4 shrink-0",
                              selected ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <span className="min-w-0 flex-1 truncate">
                            {option.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </OverlayScrollArea>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
