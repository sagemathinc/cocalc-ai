import {
  createContext,
  Suspense,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { Alert, Button } from "antd";
import { lazyWithRetry } from "@cocalc/frontend/app/lazy-with-retry";
import type { ChatActions } from "./actions";
import { captureReplyContext } from "./contextual-reply-context";
import type { ReplyContext, ReplySource } from "./contextual-reply-context";
import { extendArtifactSelection } from "./artifact-selection";

const Editor = lazyWithRetry(
  () => import("./contextual-reply-editor"),
  "local comment",
);
const CommentContext = createContext<(() => void) | undefined>(undefined);

export function LocalCommentButton({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const comment = useContext(CommentContext);
  return (
    <Button size="small" disabled={disabled || !comment} onClick={comment}>
      Comment
    </Button>
  );
}

export default function ContextualReply({
  children,
  source,
  actions,
  projectId,
  path,
  disabled = false,
  fill = false,
}: {
  children: ReactNode;
  source: ReplySource;
  actions?: ChatActions;
  projectId: string;
  path: string;
  disabled?: boolean;
  fill?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<{
    context: ReplyContext;
    rect: DOMRect;
  }>();
  const [opened, setOpened] = useState<{
    context: ReplyContext;
    rect: DOMRect;
    image?: Blob;
  }>();
  const [error, setError] = useState("");
  const [selectionError, setSelectionError] = useState("");
  const allowed = !disabled && !!actions;
  const content = () =>
    root.current?.querySelector<HTMLElement>("[data-contextual-source]") ??
    root.current;
  useEffect(() => {
    if (!allowed || opened) return;
    const capture = () => {
      const element = content();
      const selected = window.getSelection();
      if (
        !element ||
        !selected?.rangeCount ||
        selected.isCollapsed ||
        !element.contains(selected.anchorNode) ||
        !element.contains(selected.focusNode)
      ) {
        setSelection(undefined);
        setSelectionError("");
        return;
      }
      try {
        setSelection({
          context: captureReplyContext(source, element, selected),
          rect: selected.getRangeAt(0).getBoundingClientRect(),
        });
        setSelectionError("");
      } catch (err) {
        setSelection(undefined);
        setSelectionError(String(err));
      }
    };
    document.addEventListener("selectionchange", capture);
    return () => document.removeEventListener("selectionchange", capture);
  }, [allowed, source, opened]);
  async function open() {
    const element = content();
    if (!allowed || !element) return;
    setError("");
    try {
      if (selectionError) throw Error(selectionError);
      const context = {
        ...(selection?.context ?? captureReplyContext(source, element, null)),
      };
      let image: Blob | undefined;
      // Image previews use immutable browser blob URLs. Never refetch a mutable
      // project path and claim those bytes were the picture the reader saw.
      const img = element.querySelector<HTMLImageElement>(
        "img[data-comment-image]",
      );
      if (!img && source.file && /\.(png|jpe?g|gif|webp)$/i.test(source.file))
        throw Error(
          "Wait for the image preview to finish loading before commenting.",
        );
      if (img) {
        if (!img.src.startsWith("blob:"))
          throw Error("Image snapshot is not ready.");
        image = await (await fetch(img.src)).blob();
        const digest = await crypto.subtle.digest(
          "SHA-256",
          await image.arrayBuffer(),
        );
        context.image = {
          sha256: Array.from(new Uint8Array(digest), (b) =>
            b.toString(16).padStart(2, "0"),
          ).join(""),
        };
      }
      setOpened({
        context,
        image,
        rect: selection?.rect ?? element.getBoundingClientRect(),
      });
    } catch (err) {
      setError(String(err));
    }
  }
  return (
    <CommentContext.Provider value={allowed ? () => void open() : undefined}>
      <div
        ref={root}
        tabIndex={allowed ? 0 : undefined}
        onKeyDown={(event) => {
          if (
            event.target === event.currentTarget &&
            event.shiftKey &&
            extendArtifactSelection(
              event.currentTarget,
              window.getSelection(),
              event.key,
              event.ctrlKey || event.metaKey,
            )
          )
            event.preventDefault();
          if (event.key === "Escape") setSelection(undefined);
        }}
        className={fill ? "smc-vfill" : undefined}
        style={fill ? { minHeight: 0 } : undefined}
      >
        {children}
        {selectionError && <Alert type="warning" title={selectionError} />}
        {error && (
          <Alert
            type="error"
            title={error}
            closable
            onClose={() => setError("")}
          />
        )}
        {selection && !opened && (
          <Button
            size="small"
            style={{
              position: "fixed",
              zIndex: 1100,
              left: Math.max(
                8,
                Math.min(selection.rect.left, window.innerWidth - 100),
              ),
              top: Math.max(
                8,
                Math.min(selection.rect.bottom + 4, window.innerHeight - 40),
              ),
            }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void open()}
          >
            {source.kind === "message" ? "Reply" : "Comment"}
          </Button>
        )}
        {opened && actions && allowed && (
          <Suspense
            fallback={<div role="status">Loading comment editor...</div>}
          >
            <Editor
              actions={actions}
              projectId={projectId}
              path={path}
              {...opened}
              onClose={() => {
                setOpened(undefined);
                setSelection(undefined);
                root.current?.focus({ preventScroll: true });
              }}
            />
          </Suspense>
        )}
      </div>
    </CommentContext.Provider>
  );
}
