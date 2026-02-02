/*
 * This hook encapsulates layout wiring for the block editor container.
 * It owns the container ref, forwards refs, and derives gutter/row styles
 * so the core component can focus on editor state and behavior.
 */

import { useCallback, useMemo, useRef } from "react";

interface UseBlockLayoutOptions {
  minimal?: boolean;
  divRef?: React.Ref<HTMLDivElement>;
}

export function useBlockLayout({ minimal, divRef }: UseBlockLayoutOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const setContainerRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      if (typeof divRef === "function") {
        divRef(node);
      } else if (divRef && "current" in divRef) {
        (divRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }
    },
    [divRef],
  );

  const rowStyle: React.CSSProperties = useMemo(
    () => ({
      padding: minimal ? 0 : "0 70px",
      minHeight: "1px",
      position: "relative",
    }),
    [minimal],
  );
  const gutterWidth = minimal ? 0 : 70;

  return {
    containerRef,
    setContainerRef,
    rowStyle,
    gutterWidth,
  };
}
