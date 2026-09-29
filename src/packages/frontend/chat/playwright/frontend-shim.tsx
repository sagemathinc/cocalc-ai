import type { ReactNode } from "react";

export * from "../../editors/slate/playwright/frontend-shim";
export { default } from "../../editors/slate/playwright/frontend-shim";
export * from "../../editors/markdown-input/mention-all";
export * from "../../editors/markdown-input/local-history-cache";

export const Tooltip = ({ children }: { children: ReactNode }) => (
  <>{children}</>
);
export const DocsLink = Tooltip;
export const useAppearance = () => ({ resolved: "light" });
export const openAgentThread = () => {};
export const openLibrary = () => {};
export const useArtifactNames = () => ({});
export const useNamedAgents = () => ({ agents: [] });
export const sameEndpoint = () => false;
export const namedAgentReference = () => undefined;
export const ProjectTitle = () => null;
export const PeerAgentLink = () => null;
export const ChatSourceContent = () => null;
export const readablePeerMessage = (value: string) => value;
export const copyTextToClipboard = async () => {};
export const isSafeHtmlUrl = () => false;
export const ComposerConnectors = ({
  children,
}: {
  children: (extraMenuItems: unknown[]) => ReactNode;
}) => <>{children([])}</>;
export const ClaudeThreadInternetNotice = () => null;
