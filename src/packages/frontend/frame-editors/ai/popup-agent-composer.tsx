/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import ChatInput from "@cocalc/frontend/chat/input";

interface PopupAgentComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  placeholder: string;
  cacheId: string;
  autoFocus?: boolean;
  sessionToken?: number;
  fontSize?: number;
  onFontSizeChange?: (delta: -1 | 1) => void;
}

export function PopupAgentComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  cacheId,
  autoFocus = false,
  sessionToken = 1,
  fontSize,
  onFontSizeChange,
}: PopupAgentComposerProps) {
  return (
    <ChatInput
      on_send={onSubmit}
      on_font_size_change={onFontSizeChange}
      onChange={(next) => onChange(next)}
      syncdb={undefined}
      date={-1}
      input={value}
      autoFocus={autoFocus}
      autoGrowMaxHeight={280}
      placeholder={placeholder}
      cacheId={cacheId}
      sessionToken={sessionToken}
      fontSize={fontSize}
    />
  );
}
