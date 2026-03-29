import HeadTags from "./head";

export default function Meta() {
  return (
    <HeadTags
      tags={[
        { tag: "meta", attrs: { charset: "utf-8" } },
        { tag: "meta", attrs: { name: "application-name", content: "CoCalc" } },
        {
          tag: "meta",
          attrs: { name: "mobile-web-app-capable", content: "yes" },
        },
        {
          tag: "meta",
          attrs: {
            name: "apple-mobile-web-app-status-bar-style",
            content: "black",
          },
        },
        {
          tag: "meta",
          attrs: { name: "apple-mobile-web-app-title", content: "CoCalc" },
        },
        { tag: "meta", attrs: { name: "theme-color", content: "#fbb635" } },
        {
          tag: "meta",
          attrs: {
            name: "viewport",
            content: "width=device-width,initial-scale=1,user-scalable=no",
          },
        },
        { tag: "meta", attrs: { name: "google", content: "notranslate" } },
      ]}
    />
  );
}
