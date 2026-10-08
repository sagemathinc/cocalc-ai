import { useRef, useState } from "react";

interface UseMultimodeFocusInteractionOptions {
  autoFocus?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
}

export function useMultimodeFocusInteraction({
  autoFocus,
  onFocus,
  onBlur,
}: UseMultimodeFocusInteractionOptions) {
  const [focused, setFocused] = useState<boolean>(!!autoFocus);
  // The markdown editor registers its blur handler once at mount; read the
  // latest callbacks so parents never receive a stale closure.
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;
  const internalInteractionRef = useRef<"mode-switch" | null>(null);

  function beginModeSwitchInteraction() {
    internalInteractionRef.current = "mode-switch";
  }

  function endModeSwitchInteraction() {
    if (internalInteractionRef.current === "mode-switch") {
      internalInteractionRef.current = null;
    }
  }

  function shouldSuppressBlur() {
    return internalInteractionRef.current != null;
  }

  return {
    focused,
    beginModeSwitchInteraction,
    endModeSwitchInteraction,
    handleMarkdownBlur: () => {
      if (!shouldSuppressBlur()) {
        onBlurRef.current?.();
      }
    },
    handleRichTextFocus: () => {
      setFocused(true);
      onFocusRef.current?.();
    },
    handleRichTextBlur: () => {
      setFocused(false);
      if (!shouldSuppressBlur()) {
        onBlurRef.current?.();
      }
    },
  };
}
