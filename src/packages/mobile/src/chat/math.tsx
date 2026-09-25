/* CoCalc: Copyright © 2026 SageMath, Inc. License: MS-RSL. */
import { memo, useMemo, useState } from "react";
import {
  ScrollView,
  Text,
  TurboModuleRegistry,
  useWindowDimensions,
} from "react-native";
import { macros } from "@cocalc/util/markdown/math-macros";
import { usePalette } from "../ui/palette";

// Share the web renderer's definitions, including argument-taking Sage macros.
export const mathPreamble = Object.entries(macros)
  .map(([name, body]) => {
    const count = Math.max(
      0,
      ...Array.from(body.matchAll(/#(\d)/g), (m) => Number(m[1])),
    );
    return `\\def${name}${Array.from({ length: count }, (_, i) => `#${i + 1}`).join("")}{${body}}`;
  })
  .join("");

// Old development builds should remain usable until the native update is installed.
const nativeMath: typeof import("ratex-react-native") | undefined =
  TurboModuleRegistry.get("RaTeXModule")
    ? require("ratex-react-native")
    : undefined;

export const MathFormula = memo(function MathFormula({
  latex,
  display = false,
  inline = false,
}: {
  latex: string;
  display?: boolean;
  inline?: boolean;
}) {
  const colors = usePalette();
  const { width, fontScale } = useWindowDimensions();
  const [failed, setFailed] = useState<string>();
  const source = mathPreamble + latex;
  const fontSize = (display ? 20 : 16) * fontScale;
  const metrics = useMemo(() => {
    try {
      return nativeMath?.getTexMetrics(source, fontSize, display, colors.text);
    } catch {
      return null;
    }
  }, [source, fontSize, display, colors.text]);
  if (!nativeMath || !metrics || failed === latex) {
    return (
      <Text
        selectable
        accessibilityLabel={`Formula: ${latex}`}
        style={{ color: colors.text, fontFamily: "monospace" }}
      >
        {latex}
      </Text>
    );
  }
  const scale =
    display && !inline
      ? 1
      : Math.min(1, Math.max(80, width - 80) / metrics.width);
  const formula = (
    <nativeMath.RaTeXView
      latex={source}
      displayMode={display}
      fontSize={fontSize}
      color={colors.text}
      style={{
        width: metrics.width * scale,
        height: metrics.height * scale,
        alignSelf: "baseline",
      }}
      onError={() => setFailed(latex)}
    />
  );
  return display && !inline ? (
    <ScrollView
      horizontal
      accessibilityLabel={`Formula: ${latex}`}
      style={{ flexGrow: 0, marginVertical: 8 }}
    >
      {formula}
    </ScrollView>
  ) : (
    <Text accessibilityLabel={`Formula: ${latex}`}>{formula}</Text>
  );
});
