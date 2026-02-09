import React from "react";

export { React };
export type CSS = React.CSSProperties;

export const redux = {
  getStore: (name: string) => {
    if (name === "account") {
      return {
        get_account_id: () => "00000000-1000-4000-8000-000000000000",
      };
    }
    if (name === "projects") {
      return {
        hasLanguageModelEnabled: () => false,
      };
    }
    return {
      get: () => null,
    };
  },
};

export const useEffect = React.useEffect;
export const useRef = React.useRef;
export const useMemo = React.useMemo;
export const useState = React.useState;
export const useIsMountedRef = () => ({ current: true });
export const useRedux = () =>
  ({
    get: (_key: string, def?: any) => def,
    getIn: (_path: any, def?: any) => def,
    has: () => false,
  }) as any;
export const useTypedRedux = (store: string, key: string) => {
  if (store === "account" && key === "font_size") return 14;
  if (store === "account" && key === "account_id")
    return "00000000-1000-4000-8000-000000000000";
  return undefined;
};
export const useFrameContext = () => ({
  project_id: "project-1",
  path: "chat-harness.chat",
});
