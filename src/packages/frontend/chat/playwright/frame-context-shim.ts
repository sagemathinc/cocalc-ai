import { createContext, useContext } from "react";

export const defaultFrameContext = {
  id: "",
  project_id: "",
  path: "",
  actions: {},
  desc: { get: () => null },
  isFocused: false,
  isVisible: false,
  font_size: 14,
};

export const FrameContext = createContext(defaultFrameContext);
export const useFrameContext = () => useContext(FrameContext);
export const useFrameRedux = () => ({ get: () => null });
