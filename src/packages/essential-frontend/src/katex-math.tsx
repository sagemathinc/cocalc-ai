/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useRef, useState } from "react";

type KatexModule = typeof import("katex");

let katexPromise: Promise<KatexModule> | undefined;

function loadKatex(): Promise<KatexModule> {
  katexPromise ??= new Promise((resolve, reject) => {
    require.ensure(
      [],
      () => {
        require("katex/dist/katex.min.css");
        resolve(require("katex"));
      },
      reject,
      "ultralite-katex",
    );
  });
  return katexPromise;
}

export default function KatexMath({
  display,
  source,
}: {
  display: boolean;
  source: string;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    void loadKatex()
      .then((katex) => {
        if (!active || !host.current) return;
        katex.render(source, host.current, {
          displayMode: display,
          output: "htmlAndMathml",
          strict: "ignore",
          throwOnError: false,
          trust: false,
        });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [display, source]);

  return (
    <span
      className={display ? "ul-math ul-math-display" : "ul-math"}
      ref={host}
    >
      {failed ? source : null}
    </span>
  );
}
