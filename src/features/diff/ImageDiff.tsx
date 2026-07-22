import { LocateFixed, Maximize2 } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/icon-button";
import { useLocalizedFormatters } from "@/i18n/format";

import type { DiffAsset, ImageDiffContent } from "./types";

export type ImagePaneSide = "old" | "new";

export interface ImageViewportTransform {
  offsetX: number;
  offsetY: number;
  zoom: number;
}

export type ImageViewportTransforms = Record<
  ImagePaneSide,
  ImageViewportTransform
>;

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 16;

interface ImageDiffProps {
  content: ImageDiffContent;
  onActivate: (side: ImagePaneSide) => void;
  onTransformChange: (
    side: ImagePaneSide,
    update: (current: ImageViewportTransform) => ImageViewportTransform,
  ) => void;
  transforms: ImageViewportTransforms;
}

export function ImageDiff({
  content,
  onActivate,
  onTransformChange,
  transforms,
}: ImageDiffProps) {
  const { t } = useTranslation();

  return (
    <div className="grid h-full min-h-0 grid-rows-2 md:grid-cols-2 md:grid-rows-1">
      <ImagePane
        asset={content.oldImage}
        label={t("diff.oldImage")}
        onActivate={() => onActivate("old")}
        onTransformChange={(update) => onTransformChange("old", update)}
        side="old"
        transform={transforms.old}
      />
      <ImagePane
        asset={content.newImage}
        label={t("diff.newImage")}
        onActivate={() => onActivate("new")}
        onTransformChange={(update) => onTransformChange("new", update)}
        side="new"
        transform={transforms.new}
      />
    </div>
  );
}

interface ImagePaneProps {
  asset?: DiffAsset | null;
  label: string;
  onActivate: () => void;
  onTransformChange: (
    update: (current: ImageViewportTransform) => ImageViewportTransform,
  ) => void;
  side: ImagePaneSide;
  transform: ImageViewportTransform;
}

interface Point {
  x: number;
  y: number;
}

interface Size {
  height: number;
  width: number;
}

type PointerGesture =
  | {
      kind: "pan";
      pointerId: number;
      startPoint: Point;
      startTransform: ImageViewportTransform;
    }
  | {
      kind: "pinch";
      startCenter: Point;
      startDistance: number;
      startTransform: ImageViewportTransform;
    };

interface WebKitGestureEvent extends Event {
  clientX: number;
  clientY: number;
  scale: number;
}

function ImagePane({
  asset,
  label,
  onActivate,
  onTransformChange,
  side,
  transform,
}: ImagePaneProps) {
  const { t } = useTranslation();
  const formatters = useLocalizedFormatters();
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const pointersRef = React.useRef(new Map<number, Point>());
  const pointerGestureRef = React.useRef<PointerGesture | null>(null);
  const webkitGestureRef = React.useRef<{
    point: Point;
    transform: ImageViewportTransform;
  } | null>(null);
  const transformRef = React.useRef(transform);
  const [viewportSize, setViewportSize] = React.useState<Size>({
    height: 0,
    width: 0,
  });
  const [imageSize, setImageSize] = React.useState<Size>(() =>
    getAssetSize(asset),
  );

  React.useLayoutEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const measure = () => {
      const rect = viewport.getBoundingClientRect();
      const next = { height: rect.height, width: rect.width };
      setViewportSize((current) =>
        current.height === next.height && current.width === next.width
          ? current
          : next,
      );
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const emitTransform = React.useCallback(
    (next: ImageViewportTransform) => {
      const normalized = normalizeTransform(next);
      transformRef.current = normalized;
      onTransformChange(() => normalized);
    },
    [onTransformChange],
  );

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !asset) {
      return;
    }

    const onGestureStart = (event: Event) => {
      const gesture = event as WebKitGestureEvent;
      event.preventDefault();
      onActivate();
      webkitGestureRef.current = {
        point: viewportPoint(viewport, gesture.clientX, gesture.clientY),
        transform: transformRef.current,
      };
    };
    const onGestureChange = (event: Event) => {
      const gesture = event as WebKitGestureEvent;
      const start = webkitGestureRef.current;
      if (!start) {
        return;
      }
      event.preventDefault();
      emitTransform(
        zoomAtPoint(
          start.transform,
          start.transform.zoom * gesture.scale,
          start.point,
        ),
      );
    };
    const onGestureEnd = (event: Event) => {
      event.preventDefault();
      webkitGestureRef.current = null;
    };

    viewport.addEventListener("gesturestart", onGestureStart, {
      passive: false,
    });
    viewport.addEventListener("gesturechange", onGestureChange, {
      passive: false,
    });
    viewport.addEventListener("gestureend", onGestureEnd, { passive: false });
    return () => {
      viewport.removeEventListener("gesturestart", onGestureStart);
      viewport.removeEventListener("gesturechange", onGestureChange);
      viewport.removeEventListener("gestureend", onGestureEnd);
    };
  }, [asset, emitTransform, onActivate]);

  const fitScale = calculateFitScale(viewportSize, imageSize);
  const displayScale = fitScale * transform.zoom;
  const paneClassName =
    side === "old"
      ? "flex min-h-0 min-w-0 flex-col overflow-hidden border-b md:border-b-0 md:border-r"
      : "flex min-h-0 min-w-0 flex-col overflow-hidden";

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (
      !asset ||
      (event.pointerType === "mouse" && event.button !== 0) ||
      (event.target as Element).closest("[data-image-controls]")
    ) {
      return;
    }

    event.preventDefault();
    onActivate();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    pointerGestureRef.current = createPointerGesture(
      pointersRef.current,
      transformRef.current,
    );
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) {
      return;
    }

    event.preventDefault();
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const gesture = pointerGestureRef.current;
    if (!gesture) {
      return;
    }

    if (gesture.kind === "pan") {
      const point = pointersRef.current.get(gesture.pointerId);
      if (!point) {
        return;
      }
      emitTransform({
        ...gesture.startTransform,
        offsetX:
          gesture.startTransform.offsetX + point.x - gesture.startPoint.x,
        offsetY:
          gesture.startTransform.offsetY + point.y - gesture.startPoint.y,
      });
      return;
    }

    const points = [...pointersRef.current.values()];
    if (points.length < 2) {
      return;
    }
    const center = midpoint(points[0], points[1]);
    const distance = pointDistance(points[0], points[1]);
    const nextZoom =
      gesture.startTransform.zoom * (distance / gesture.startDistance);
    const zoomed = zoomAtPoint(
      gesture.startTransform,
      nextZoom,
      viewportPoint(
        event.currentTarget,
        gesture.startCenter.x,
        gesture.startCenter.y,
      ),
    );
    emitTransform({
      ...zoomed,
      offsetX: zoomed.offsetX + center.x - gesture.startCenter.x,
      offsetY: zoomed.offsetY + center.y - gesture.startCenter.y,
    });
  };

  const finishPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    pointerGestureRef.current = createPointerGesture(
      pointersRef.current,
      transformRef.current,
    );
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (!asset || webkitGestureRef.current) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onActivate();
    const delta = normalizeWheelDelta(event);
    const sensitivity = event.ctrlKey ? 0.01 : 0.002;
    const nextZoom = transformRef.current.zoom * Math.exp(-delta * sensitivity);
    emitTransform(
      zoomAtPoint(
        transformRef.current,
        nextZoom,
        viewportPoint(event.currentTarget, event.clientX, event.clientY),
      ),
    );
  };

  return (
    <section className={paneClassName}>
      <header className="flex h-9 shrink-0 items-center justify-between gap-2 border-b px-3 text-xs">
        <span className="font-medium">{label}</span>
        {asset ? (
          <span className="truncate text-muted-foreground">
            {formatImageMeta(asset, formatters.formatFileSize)}
          </span>
        ) : null}
      </header>
      <div
        aria-label={t("diff.imagePreview", { label })}
        className="diff-checkerboard relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden active:cursor-grabbing"
        data-image-viewport={side}
        onPointerCancel={finishPointer}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        onWheel={handleWheel}
        ref={viewportRef}
      >
        {asset ? (
          <div
            className="pointer-events-none absolute left-1/2 top-1/2 will-change-transform"
            data-image-stage={side}
            style={{
              transform: `translate3d(${transform.offsetX}px, ${transform.offsetY}px, 0)`,
            }}
          >
            <img
              alt={asset.alt ?? label}
              className="block max-h-none max-w-none origin-center select-none"
              draggable={false}
              height={asset.height ?? undefined}
              onLoad={(event) => {
                const image = event.currentTarget;
                if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                  setImageSize({
                    height: image.naturalHeight,
                    width: image.naturalWidth,
                  });
                }
              }}
              src={asset.src}
              style={{
                transform: `translate(-50%, -50%) scale(${displayScale})`,
              }}
              width={asset.width ?? undefined}
            />
          </div>
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
            {t("diff.imageMissing")}
          </div>
        )}
        {asset ? (
          <div
            className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md border bg-background/90 p-1 shadow-sm backdrop-blur-sm"
            data-image-controls
            onPointerDown={(event) => event.stopPropagation()}
          >
            <IconButton
              className="size-8"
              label={t("diff.resetImagePosition")}
              onClick={() =>
                emitTransform({
                  ...transformRef.current,
                  offsetX: 0,
                  offsetY: 0,
                })
              }
              variant="ghost"
            >
              <LocateFixed className="size-4" aria-hidden="true" />
            </IconButton>
            <IconButton
              className="size-8"
              label={t("diff.fitImageToPreview")}
              onClick={() =>
                emitTransform({ ...transformRef.current, zoom: 1 })
              }
              variant="ghost"
            >
              <Maximize2 className="size-4" aria-hidden="true" />
            </IconButton>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function getAssetSize(asset?: DiffAsset | null): Size {
  return {
    height: positiveNumber(asset?.height),
    width: positiveNumber(asset?.width),
  };
}

function positiveNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function calculateFitScale(viewport: Size, image: Size): number {
  if (
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    image.width <= 0 ||
    image.height <= 0
  ) {
    return 1;
  }

  return Math.min(
    1,
    viewport.width / image.width,
    viewport.height / image.height,
  );
}

function normalizeTransform(
  transform: ImageViewportTransform,
): ImageViewportTransform {
  return {
    offsetX: Number.isFinite(transform.offsetX) ? transform.offsetX : 0,
    offsetY: Number.isFinite(transform.offsetY) ? transform.offsetY : 0,
    zoom: clamp(transform.zoom, MIN_ZOOM, MAX_ZOOM),
  };
}

function zoomAtPoint(
  transform: ImageViewportTransform,
  zoom: number,
  point: Point,
): ImageViewportTransform {
  const nextZoom = clamp(zoom, MIN_ZOOM, MAX_ZOOM);
  const ratio = nextZoom / transform.zoom;
  return {
    offsetX: point.x - (point.x - transform.offsetX) * ratio,
    offsetY: point.y - (point.y - transform.offsetY) * ratio,
    zoom: nextZoom,
  };
}

function viewportPoint(
  viewport: HTMLElement,
  clientX: number,
  clientY: number,
): Point {
  const rect = viewport.getBoundingClientRect();
  return {
    x: clientX - rect.left - rect.width / 2,
    y: clientY - rect.top - rect.height / 2,
  };
}

function normalizeWheelDelta(event: React.WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * 16;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * event.currentTarget.clientHeight;
  }
  return event.deltaY;
}

function createPointerGesture(
  pointers: Map<number, Point>,
  transform: ImageViewportTransform,
): PointerGesture | null {
  const entries = [...pointers.entries()];
  if (entries.length === 0) {
    return null;
  }
  if (entries.length === 1) {
    return {
      kind: "pan",
      pointerId: entries[0][0],
      startPoint: entries[0][1],
      startTransform: transform,
    };
  }

  const first = entries[0][1];
  const second = entries[1][1];
  return {
    kind: "pinch",
    startCenter: midpoint(first, second),
    startDistance: Math.max(1, pointDistance(first, second)),
    startTransform: transform,
  };
}

function midpoint(first: Point, second: Point): Point {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function pointDistance(first: Point, second: Point): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatImageMeta(
  asset: DiffAsset,
  formatFileSize: (bytes: number) => string,
): string {
  const dimensions =
    asset.width && asset.height
      ? `${asset.width} x ${asset.height}`
      : undefined;
  const size =
    asset.sizeBytes === undefined || asset.sizeBytes === null
      ? undefined
      : formatFileSize(asset.sizeBytes);

  return [dimensions, size].filter(Boolean).join(" · ");
}
