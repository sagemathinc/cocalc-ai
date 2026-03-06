import type {
  FocusEventHandler,
  HTMLAttributes,
  MouseEventHandler,
  PropsWithChildren,
} from "react";
import { useCallback } from "react";
import { redux } from "@cocalc/frontend/app-framework";

export const KEYBOARD_BOUNDARY_ATTRIBUTE = "data-cocalc-keyboard-boundary";
export const KEYBOARD_BOUNDARY_SELECTOR = `[${KEYBOARD_BOUNDARY_ATTRIBUTE}]`;

const INPUT_TAGS = new Set(["input", "textarea", "select", "button"]);
const EDITABLE_OR_INTERACTIVE_SELECTOR = [
  '[contenteditable="true"]',
  '[data-slate-editor="true"]',
  ".slate-editor",
  ".CodeMirror",
  ".CodeMirror-code",
  ".cm-editor",
  ".cm-content",
  '[role="textbox"]',
  '[role="combobox"]',
].join(", ");

function isElement(value: unknown): value is Element {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as Element).closest === "function"
  );
}

function isHTMLElementLike(value: unknown): value is HTMLElement {
  return (
    isElement(value) &&
    typeof (value as HTMLElement).tagName === "string"
  );
}

function isEventLike(value: unknown): value is Event {
  return (
    value != null &&
    typeof value === "object" &&
    "target" in (value as Event)
  );
}

function isNodeLike(value: unknown): value is Node {
  return (
    value != null &&
    typeof value === "object" &&
    typeof (value as Node).nodeType === "number"
  );
}

function getClosestBoundary(value: unknown): HTMLElement | null {
  if (!isElement(value)) return null;
  const boundary = value.closest(KEYBOARD_BOUNDARY_SELECTOR);
  return isHTMLElementLike(boundary) ? boundary : null;
}

export function getEventPath(event: unknown): EventTarget[] {
  if (event != null && typeof (event as Event).composedPath === "function") {
    const path = (event as Event).composedPath();
    if (Array.isArray(path) && path.length > 0) {
      return path;
    }
  }
  const path: EventTarget[] = [];
  let current: any = isEventLike(event) ? event.target : null;
  while (current != null) {
    path.push(current);
    current = current.parentNode ?? current.host ?? null;
  }
  if (typeof document !== "undefined") path.push(document);
  if (typeof window !== "undefined") path.push(window);
  return path;
}

export function getKeyboardBoundaryElement(value: unknown): HTMLElement | null {
  if (value == null) return null;
  if (isEventLike(value)) {
    for (const entry of getEventPath(value)) {
      const boundary = getClosestBoundary(entry);
      if (boundary != null) return boundary;
    }
    return null;
  }
  return getClosestBoundary(value);
}

export function isInsideKeyboardBoundary(value: unknown): boolean {
  return getKeyboardBoundaryElement(value) != null;
}

export function eventTargetsElement(
  event: unknown,
  element: Element | null | undefined,
): boolean {
  if (!isEventLike(event) || !isElement(element)) return false;
  for (const entry of getEventPath(event)) {
    if (entry === element) return true;
    if (isNodeLike(entry) && element.contains(entry)) return true;
  }
  const target = event.target;
  return isNodeLike(target) ? element.contains(target) : false;
}

export function isEditableOrKeyboardInteractiveTarget(
  target: EventTarget | null | undefined,
): boolean {
  if (!isHTMLElementLike(target)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  if (INPUT_TAGS.has(tag)) return true;
  return Boolean(target.closest(EDITABLE_OR_INTERACTIVE_SELECTOR));
}

export function shouldSuppressGlobalShortcuts(
  event?: Event | null,
  activeElement: Element | null =
    typeof document === "undefined" ? null : document.activeElement,
): boolean {
  return (
    isInsideKeyboardBoundary(event) ||
    isInsideKeyboardBoundary(activeElement) ||
    isEditableOrKeyboardInteractiveTarget(event?.target) ||
    isEditableOrKeyboardInteractiveTarget(activeElement)
  );
}

function composeEventHandlers<E>(
  theirs: ((event: E) => void) | undefined,
  ours: ((event: E) => void) | undefined,
): ((event: E) => void) | undefined {
  if (theirs == null) return ours;
  if (ours == null) return theirs;
  return (event: E) => {
    theirs(event);
    ours(event);
  };
}

export interface KeyboardBoundaryOptions<E extends HTMLElement = HTMLDivElement> {
  boundary?: string;
  clearPageHandlerOnFocus?: boolean;
  stopMouseDownPropagation?: boolean;
  stopClickPropagation?: boolean;
  onFocus?: FocusEventHandler<E>;
  onMouseDown?: MouseEventHandler<E>;
  onClick?: MouseEventHandler<E>;
}

export function useKeyboardBoundary<E extends HTMLElement = HTMLDivElement>({
  boundary = "overlay",
  clearPageHandlerOnFocus = true,
  stopMouseDownPropagation = false,
  stopClickPropagation = false,
  onFocus,
  onMouseDown,
  onClick,
}: KeyboardBoundaryOptions<E> = {}) {
  const clearPageHandler = useCallback(() => {
    redux.getActions("page")?.erase_active_key_handler?.();
  }, []);

  const handleFocus = useCallback<FocusEventHandler<E>>(
    (event) => {
      if (clearPageHandlerOnFocus) {
        clearPageHandler();
      }
      onFocus?.(event);
    },
    [clearPageHandler, clearPageHandlerOnFocus, onFocus],
  );

  const stopEventPropagation = useCallback(
    (event: { stopPropagation: () => void }) => {
      event.stopPropagation();
    },
    [],
  );

  return {
    [KEYBOARD_BOUNDARY_ATTRIBUTE]: boundary,
    onFocus:
      clearPageHandlerOnFocus || onFocus != null ? handleFocus : undefined,
    onMouseDown:
      stopMouseDownPropagation || onMouseDown != null
        ? composeEventHandlers(
            onMouseDown,
            stopMouseDownPropagation ? stopEventPropagation : undefined,
          )
        : undefined,
    onClick:
      stopClickPropagation || onClick != null
        ? composeEventHandlers(
            onClick,
            stopClickPropagation ? stopEventPropagation : undefined,
          )
        : undefined,
  };
}

export type KeyboardBoundaryProps = PropsWithChildren<
  Omit<HTMLAttributes<HTMLDivElement>, "onFocus" | "onMouseDown" | "onClick"> &
    KeyboardBoundaryOptions<HTMLDivElement>
>;

export function KeyboardBoundary({
  boundary = "overlay",
  clearPageHandlerOnFocus = true,
  stopMouseDownPropagation = false,
  stopClickPropagation = false,
  onFocus,
  onMouseDown,
  onClick,
  children,
  ...props
}: KeyboardBoundaryProps) {
  const boundaryProps = useKeyboardBoundary<HTMLDivElement>({
    boundary,
    clearPageHandlerOnFocus,
    stopMouseDownPropagation,
    stopClickPropagation,
    onFocus,
    onMouseDown,
    onClick,
  });
  return (
    <div {...props} {...boundaryProps}>
      {children}
    </div>
  );
}
