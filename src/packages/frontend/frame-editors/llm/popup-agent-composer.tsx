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
}

export function PopupAgentComposer({
  value,
  onChange,
  onSubmit,
  placeholder,
  cacheId,
  autoFocus = false,
  sessionToken = 1,
}: PopupAgentComposerProps) {
  return (
    <ChatInput
      on_send={onSubmit}
      onChange={(next) => onChange(next)}
      syncdb={undefined}
      date={-1}
      input={value}
      autoFocus={autoFocus}
      autoGrowMaxHeight={280}
      placeholder={placeholder}
      cacheId={cacheId}
      sessionToken={sessionToken}
    />
  );
}
