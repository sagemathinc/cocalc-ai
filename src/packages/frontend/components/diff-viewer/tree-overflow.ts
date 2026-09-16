export interface TreeOverflow {
  above: boolean;
  below: boolean;
}

// Trees virtualizes inside an open shadow root. Keep its DOM adapter here;
// never infer overflow from the handful of currently mounted rows.
export function watchTreeOverflow(
  getHost: () => HTMLElement | undefined,
  onChange: (overflow: TreeOverflow) => void,
): () => void {
  let frame: number | undefined;
  let root: ShadowRoot | null | undefined;
  let viewport: HTMLElement | null = null;
  let attempts = 0;
  let disposed = false;
  const schedule = () => {
    if (!disposed && frame == null) frame = requestAnimationFrame(update);
  };
  const mutation = new MutationObserver(schedule);
  const resize = new ResizeObserver(schedule);
  const update = () => {
    frame = undefined;
    const nextRoot = getHost()?.shadowRoot;
    if (!nextRoot) {
      if (++attempts < 60) schedule();
      return;
    }
    if (root !== nextRoot) {
      root?.removeEventListener("scroll", schedule, true);
      mutation.disconnect();
      root = nextRoot;
      root.addEventListener("scroll", schedule, true);
      mutation.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["style"],
      });
    }
    const nextViewport = root.querySelector<HTMLElement>(
      "[data-file-tree-virtualized-scroll]",
    );
    if (nextViewport !== viewport) {
      resize.disconnect();
      viewport = nextViewport;
      if (viewport) resize.observe(viewport);
    }
    if (!viewport) return;
    onChange({
      above: viewport.scrollTop > 1,
      below:
        viewport.clientHeight > 0 &&
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1,
    });
  };
  schedule();
  return () => {
    disposed = true;
    if (frame != null) cancelAnimationFrame(frame);
    root?.removeEventListener("scroll", schedule, true);
    mutation.disconnect();
    resize.disconnect();
  };
}
