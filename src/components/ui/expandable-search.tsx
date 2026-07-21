import { Loader2, Search, X } from "lucide-react";
import * as React from "react";

import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";

export interface ExpandableSearchProps {
  clearLabel: string;
  /** Marks this control as the app-wide Cmd/Ctrl+F search target. */
  dataAppSearch?: string;
  expandedClassName?: string;
  isSearching?: boolean;
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: "sm" | "md";
  value: string;
  className?: string;
  inputClassName?: string;
  inputProps?: Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    | "aria-label"
    | "className"
    | "onChange"
    | "placeholder"
    | "value"
    | "data-app-search"
  >;
}

export function ExpandableSearch({
  className,
  clearLabel,
  dataAppSearch,
  expandedClassName,
  inputClassName,
  inputProps,
  isSearching = false,
  label,
  onChange,
  placeholder,
  size = "md",
  value,
}: ExpandableSearchProps) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = React.useState(() => value.length > 0);
  const open = expanded || value.length > 0;
  const compact = size === "sm";
  const controlSizeClass = compact ? "size-8" : "size-9";
  const fieldHeightClass = compact ? "h-8" : "h-9";

  React.useLayoutEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  const collapseIfEmpty = React.useCallback(() => {
    if (value.trim().length === 0) {
      setExpanded(false);
    }
  }, [value]);

  return (
    <div
      className={cn(
        "relative flex items-center justify-end overflow-hidden transition-[width,max-width,flex-basis,flex-grow,flex-shrink] duration-200 ease-out",
        open
          ? cn("min-w-0", expandedClassName ?? "w-44 flex-none")
          : cn(controlSizeClass, "flex-none"),
        className,
      )}
      data-expanded={open ? "true" : undefined}
      data-testid="expandable-search"
      onBlur={(event) => {
        const nextTarget = event.relatedTarget;
        if (
          nextTarget instanceof Node &&
          containerRef.current?.contains(nextTarget)
        ) {
          return;
        }
        collapseIfEmpty();
      }}
      ref={containerRef}
    >
      {open ? (
        <>
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2 size-4 text-muted-foreground"
          />
          <input
            {...inputProps}
            aria-label={label}
            className={cn(
              fieldHeightClass,
              "expandable-search-input w-full rounded-md border bg-background pl-8 pr-8 text-sm outline-none focus-visible:outline-none focus-visible:ring-0",
              inputClassName,
            )}
            data-app-search={dataAppSearch}
            onChange={(event) => {
              onChange(event.target.value);
            }}
            onKeyDown={(event) => {
              inputProps?.onKeyDown?.(event);
              if (event.defaultPrevented || event.key !== "Escape") {
                return;
              }
              if (value.length > 0) {
                onChange("");
                return;
              }
              setExpanded(false);
            }}
            placeholder={placeholder}
            ref={inputRef}
            value={value}
          />
          {isSearching ? (
            <Loader2
              aria-hidden="true"
              className="absolute right-2 size-4 animate-spin text-muted-foreground"
            />
          ) : value ? (
            <IconButton
              className="absolute right-0.5 size-7"
              label={clearLabel}
              onClick={() => {
                onChange("");
                inputRef.current?.focus();
              }}
              tooltip={clearLabel}
              variant="ghost"
            >
              <X className="size-3.5" aria-hidden="true" />
            </IconButton>
          ) : null}
        </>
      ) : (
        <IconButton
          className={controlSizeClass}
          data-app-search={dataAppSearch}
          label={label}
          onClick={() => {
            setExpanded(true);
          }}
          onFocus={() => {
            setExpanded(true);
          }}
          tooltip={label}
          variant="ghost"
        >
          <Search className="size-4" aria-hidden="true" />
        </IconButton>
      )}
    </div>
  );
}
