import React from "react";

export const ReactShim = React;
export const ReactDOMShim = {};
export type CSS = React.CSSProperties;

export const Icon = (_props: any) => null;
export const CopyButton = (_props: any) => null;
export const Button = (_props: any) => null;
export const Tooltip = (_props: any) => null;
export const Popover = (_props: any) => null;
export const A = (props: any) => React.createElement("a", props);

export const useFileContext = () => ({});
export const FileContext = React.createContext({});

export const redux = {
  getStore: () => ({
    get: () => null,
  }),
};
export const useRedux = () => ({} as any);
export const useIsMountedRef = () => ({ current: true });
export const useEffect = React.useEffect;
export const useMemo = React.useMemo;
export const useRef = React.useRef;
export const useState = React.useState;
export const useFrameContext = () => ({ project_id: "", path: "" });

export const i18n = (s: string) => s;
export const getLocale = () => "en";
export const alert_message = () => undefined;
export const ai_gen_formula = async () => "";
export const get_insert_image_opts_from_user = async () => null;
export const get_insert_link_opts_from_user = async () => null;
export const get_insert_special_char_from_user = async () => null;
export const commands: Record<string, () => void> = {};
export const file_associations = {};
export const detectLanguage = () => null;
export const open_new_tab = () => undefined;
export const TITLE_BAR_BORDER = "1px solid #ddd";

export const CodeMirrorStatic = (_props: any) => null;
export const RunButton = (_props: any) => null;

const DefaultStub = (props: any) =>
  props?.children ? React.createElement(React.Fragment, null, props.children) : null;
export default DefaultStub;
