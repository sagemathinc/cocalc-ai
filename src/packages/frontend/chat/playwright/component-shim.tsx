import React from "react";

export const BLURED_STYLE: React.CSSProperties = {
  border: "1px solid #ccc",
  borderRadius: "5px",
};

export const FOCUSED_STYLE: React.CSSProperties = {
  border: "1px solid #719ECE",
  borderRadius: "5px",
  boxShadow: "0 0 4px #719ECE",
};

export function MarkdownInput(props: any): React.JSX.Element {
  const {
    value = "",
    onChange,
    onShiftEnter,
    onFocus,
    onBlur,
    placeholder,
    style,
    autoFocus,
  } = props;

  return (
    <textarea
      data-testid="markdown-input-shim"
      autoFocus={autoFocus}
      value={value}
      placeholder={placeholder}
      onFocus={() => onFocus?.()}
      onBlur={() => onBlur?.(value)}
      onChange={(e) => onChange?.(e.currentTarget.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && e.shiftKey) {
          e.preventDefault();
          onShiftEnter?.(value.endsWith("\n") ? value : `${value}\n`);
        }
      }}
      style={{
        width: "100%",
        minHeight: 80,
        padding: 8,
        fontFamily: "monospace",
        fontSize: 14,
        ...style,
      }}
    />
  );
}
