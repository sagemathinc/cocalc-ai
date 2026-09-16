import { createContext } from "react";

// A mounted pane, not a chat path: the same thread can be open in two panes.
export const SpeechPaneContext = createContext<symbol | undefined>(undefined);
