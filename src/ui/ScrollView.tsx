import { useEffect, useRef, useState, type ReactNode } from "react";
import { Box, useBoxMetrics, useInput } from "ink";
import { mouse, type MouseEvent } from "../mouse.ts";

const WHEEL_ROWS = 3;

interface Props {
  children: ReactNode;
  /** Change this to jump back to the bottom (e.g. when the user sends a message). */
  followKey?: number;
  isActive?: boolean;
}

// The alternate screen has no terminal scrollback, so ekko scrolls its own
// transcript. The viewport fills whatever height its parent gives it and
// clips the content, which is shifted up by `contentOffsetY` rows.
//
// It follows the bottom (like a chat) until you press PgUp or scroll up. Then
// it stays where you scrolled, even while a reply streams in, until you scroll
// back down or `followKey` changes.
export function ScrollView({ children, followKey = 0, isActive = true }: Props) {
  const viewportRef = useRef(null);
  const contentRef = useRef(null);
  const viewport = useBoxMetrics(viewportRef);
  const content = useBoxMetrics(contentRef);

  // null = following the bottom; otherwise the row pinned to the top.
  const [top, setTop] = useState<number | null>(null);
  useEffect(() => setTop(null), [followKey]);

  // Clamp on every render: the maximum changes as content grows or the terminal resizes.
  const maxTop = Math.max(0, content.height - viewport.clientHeight);
  const scrollTop = top === null ? maxTop : Math.min(top, maxTop);
  // Keep one row of overlap so you don't lose your place.
  const page = Math.max(1, viewport.clientHeight - 1);

  // Functional update: a fast wheel spin delivers several notches before the
  // next render, and each must build on the last.
  const scrollBy = (rows: number) =>
    setTop((prev) => {
      const current = prev === null ? maxTop : Math.min(prev, maxTop);
      const next = Math.max(0, current + rows);
      return next >= maxTop ? null : next;
    });

  useInput(
    (_input, key) => {
      if (key.pageUp) scrollBy(-page);
      else if (key.pageDown) scrollBy(page);
    },
    { isActive },
  );

  // Wheel notches come from src/mouse.ts, which filters them out of stdin.
  // Re-subscribed every render so the handler sees the current maxTop.
  useEffect(() => {
    if (!isActive) return;
    const onMouse = (event: MouseEvent) => {
      if (event.type === "scroll") scrollBy(event.step * WHEEL_ROWS);
    };
    mouse.on("event", onMouse);
    return () => {
      mouse.off("event", onMouse);
    };
  });

  return (
    <Box ref={viewportRef} flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden" contentOffsetY={scrollTop}>
      {/* flexShrink={0} keeps the content at its natural height, so it can overflow the viewport. */}
      <Box ref={contentRef} flexDirection="column" flexShrink={0}>
        {children}
      </Box>
    </Box>
  );
}
