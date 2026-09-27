import { createContext, useContext } from "react";
import type { ReactNode } from "react";
import { FileContext, useFileContext } from "@cocalc/frontend/lib/file-context";
import type { IFileContext } from "@cocalc/frontend/lib/file-context";

export const ChatSourceFileContext = createContext<IFileContext | undefined>(
  undefined,
);

// Guidance belongs to the chat file, not the enclosing agent turn's cwd.
export function ChatSourceContent({ children }: { children: ReactNode }) {
  const source = useContext(ChatSourceFileContext);
  const current = useFileContext();
  return (
    <FileContext.Provider value={source ?? current}>
      {children}
    </FileContext.Provider>
  );
}
