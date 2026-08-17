/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { Fragment, useEffect, useState, type ReactNode } from "react";
import type { UltraliteLanguage } from "./code-language";
import { loadLanguage, Prism } from "./prism-languages";
import { InlineAlert, LoadingState } from "./ui";

function tokenClass(token: Prism.Token): string {
  const aliases = Array.isArray(token.alias)
    ? token.alias
    : token.alias
      ? [token.alias]
      : [];
  return ["token", token.type, ...aliases].join(" ");
}

function renderTokens(tokens: Array<string | Prism.Token>, key = "t") {
  return tokens.map((token, index): ReactNode => {
    const tokenKey = `${key}-${index}`;
    if (typeof token === "string") {
      return <Fragment key={tokenKey}>{token}</Fragment>;
    }
    const content = Array.isArray(token.content)
      ? renderTokens(token.content, tokenKey)
      : token.content instanceof Prism.Token
        ? renderTokens([token.content], tokenKey)
        : token.content;
    return (
      <span className={tokenClass(token)} key={tokenKey}>
        {content}
      </span>
    );
  });
}

export default function HighlightedCode({
  className = "ul-code-view",
  contents,
  language,
  showStatus = false,
  wrap = false,
}: {
  className?: string;
  contents: string;
  language?: UltraliteLanguage;
  showStatus?: boolean;
  wrap?: boolean;
}) {
  const [grammar, setGrammar] = useState<Prism.Grammar>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setGrammar(undefined);
    setFailed(false);
    void loadLanguage(language)
      .then((value) => {
        if (!cancelled) setGrammar(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [language]);

  const children =
    grammar && language
      ? renderTokens(Prism.tokenize(contents, grammar))
      : contents;
  return (
    <>
      {showStatus && language && !grammar && !failed ? (
        <LoadingState label="Loading syntax highlighting" />
      ) : null}
      {showStatus && failed ? (
        <InlineAlert kind="warning">
          Syntax highlighting could not be loaded. Plain text is still safe and
          available.
        </InlineAlert>
      ) : null}
      <pre className={`${className} ${wrap ? "ul-code-wrap" : ""}`}>
        <code className={language ? `language-${language}` : undefined}>
          {children}
        </code>
      </pre>
    </>
  );
}
