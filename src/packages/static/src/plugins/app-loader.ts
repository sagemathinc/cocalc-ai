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
