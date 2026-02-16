import React from "react";

export { React };
export type CSS = React.CSSProperties;

export const redux = {
  getStore: () => ({
    get: () => null,
  }),
};

export const useEffect = React.useEffect;
export const useRef = React.useRef;
export const useMemo = React.useMemo;
export const useState = React.useState;
export const useIsMountedRef = () => ({ current: true });
export const useRedux = () => undefined;

export const useFrameContext = () => ({
  project_id: "",
  path: "",
});
