/* CoCalc: Copyright © 2026 SageMath, Inc. License: MS-RSL. */
import { createContext, useContext, useEffect, useState } from "react";
import {
  Image,
  Text,
  useWindowDimensions,
  type ImageSourcePropType,
} from "react-native";
import { usePalette } from "../ui/palette";
export type ImageResolver = (src: string) => Promise<ImageSourcePropType>;
export const MarkdownImageContext = createContext<ImageResolver | undefined>(
  undefined,
);

export function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const resolve = useContext(MarkdownImageContext);
  const colors = usePalette();
  const { width } = useWindowDimensions();
  const [source, setSource] = useState<ImageSourcePropType>();
  const [failed, setFailed] = useState(false);
  const [ratio, setRatio] = useState(1.5);
  useEffect(() => {
    let active = true;
    setFailed(false);
    setSource(undefined);
    setRatio(1.5);
    const pending = /^https?:\/\//i.test(src)
      ? Promise.resolve({ uri: src })
      : resolve?.(src);
    if (!pending) setFailed(true);
    else
      void pending
        .then((value) => {
          if (active) setSource(value);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    return () => {
      active = false;
    };
  }, [src, resolve]);
  if (failed)
    return (
      <Text style={{ color: colors.secondary }}>
        [Image unavailable: {alt || src}]
      </Text>
    );
  if (!source)
    return (
      <Text style={{ color: colors.secondary }}>
        Loading image: {alt || "attachment"}…
      </Text>
    );
  const imageWidth = Math.min(320, Math.max(80, width - 80));
  return (
    <Image
      source={source}
      accessibilityRole="image"
      accessibilityLabel={alt || "Image attachment"}
      resizeMode="contain"
      style={{ width: imageWidth, height: Math.min(500, imageWidth / ratio) }}
      onLoad={(event) => {
        const { width: w, height: h } = event.nativeEvent.source;
        if (w > 0 && h > 0) setRatio(w / h);
      }}
      onError={() => setFailed(true)}
    />
  );
}
