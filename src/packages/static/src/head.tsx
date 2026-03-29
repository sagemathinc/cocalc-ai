import { useEffect } from "react";

type HeadTag = {
  tag: "link" | "meta";
  attrs: Record<string, string | undefined>;
};

function setAttrs(
  elt: HTMLLinkElement | HTMLMetaElement,
  attrs: Record<string, string | undefined>,
): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) {
      elt.setAttribute(key, value);
    }
  }
}

export default function HeadTags({ tags }: { tags: HeadTag[] }) {
  const signature = JSON.stringify(tags);

  useEffect(() => {
    const elts = tags.map(({ tag, attrs }) => {
      const elt = document.createElement(tag) as
        | HTMLLinkElement
        | HTMLMetaElement;
      elt.setAttribute("data-cocalc-head-tag", "true");
      setAttrs(elt, attrs);
      document.head.appendChild(elt);
      return elt;
    });

    return () => {
      for (const elt of elts) {
        elt.remove();
      }
    };
  }, [signature]);

  return null;
}
