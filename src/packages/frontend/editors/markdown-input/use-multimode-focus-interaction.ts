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
        onBlur?.();
      }
    },
    handleRichTextFocus: () => {
      setFocused(true);
      onFocus?.();
    },
    handleRichTextBlur: () => {
      setFocused(false);
      if (!shouldSuppressBlur()) {
        onBlur?.();
      }
    },
  };
}
