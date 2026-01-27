import React, { createContext, useContext } from "react";

export const defaultFrameContext = {
  id: "",
  project_id: "",
  path: "",
  actions: {},
  desc: { get: () => null },
  isFocused: true,
  isVisible: true,
  font_size: 14,
};

export const FrameContext = createContext(defaultFrameContext);

export function useFrameContext() {
  return useContext(FrameContext);
}

export function useFrameRedux() {
  return { get: () => null };
}

