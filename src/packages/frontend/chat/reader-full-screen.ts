/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Inside the reader, a message's "Focus message" button shows its item full
// screen as the reader does (subject, Newer, Older, Archive, the keys),
// rather than the message alone.

import { createContext, useContext } from "react";

export interface ReaderFullScreen {
  open: () => void;
}

export const ReaderFullScreenContext = createContext<ReaderFullScreen | null>(
  null,
);

export function useReaderFullScreen(): ReaderFullScreen | null {
  return useContext(ReaderFullScreenContext);
}
