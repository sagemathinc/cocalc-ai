import rspack from "@rspack/core";
import { resolve } from "path";

export default function appLoaderPlugin(
  registerPlugin,
  PRODMODE: boolean,
  title: string,
) {
  const htmlPages = [
    { desc: "app", filename: "app.html", chunks: ["load", "app"] },
    { desc: "embed", filename: "embed.html", chunks: ["load", "embed"] },
    {
      desc: "public-viewer",
      filename: "public-viewer.html",
      chunks: ["load", "public-viewer"],
    },
    {
      desc: "public-viewer-md",
      filename: "public-viewer-md.html",
      chunks: ["load", "public-viewer-md"],
    },
    {
      desc: "public-viewer-ipynb",
      filename: "public-viewer-ipynb.html",
      chunks: ["load", "public-viewer-ipynb"],
    },
    {
      desc: "public-viewer-board",
      filename: "public-viewer-board.html",
      chunks: ["load", "public-viewer-board"],
    },
    {
      desc: "public-viewer-slides",
      filename: "public-viewer-slides.html",
      chunks: ["load", "public-viewer-slides"],
    },
    {
      desc: "public-viewer-chat",
      filename: "public-viewer-chat.html",
      chunks: ["load", "public-viewer-chat"],
    },
    {
      desc: "public-auth",
      filename: "public-auth.html",
      chunks: ["load", "public-auth"],
    },
    {
      desc: "public-support",
      filename: "public-support.html",
      chunks: ["load", "public-support"],
    },
    {
      desc: "public-content",
      filename: "public-content.html",
      chunks: ["load", "public-content"],
    },
    {
      desc: "public-features",
      filename: "public-features.html",
      chunks: ["load", "public-features"],
    },
  ];

  for (const page of htmlPages) {
    registerPlugin(
      `HTML -- generates the ${page.filename} file`,
      new rspack.HtmlRspackPlugin({
        title,
        filename: page.filename,
        template: resolve(__dirname, "../app.html"),
        hash: PRODMODE,
        chunks: page.chunks,
      }),
    );
  }
}
