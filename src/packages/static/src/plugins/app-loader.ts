import rspack from "@rspack/core";
import { PUBLIC_STATIC_BASE_PLACEHOLDER } from "@cocalc/util/public-site-metadata";
import { renderAppTemplate } from "./app-template";

export default function appLoaderPlugin(registerPlugin, PRODMODE: boolean) {
  const htmlPages: {
    chunks: string[];
    desc: string;
    filename: string;
    publicPath?: string;
  }[] = [
    { desc: "app", filename: "app.html", chunks: ["load", "app"] },
    {
      desc: "ultralite",
      filename: "ultralite.html",
      chunks: ["ultralite"],
    },
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
      desc: "public",
      filename: "public.html",
      chunks: ["load", "public"],
      // The hub serves this shell at clean URLs (/, /docs/a/b, ...), so its
      // asset URLs cannot be relative. Emit them behind the shared token,
      // which the hub replaces with the serve-time static location. The
      // other shells are served from /static/ itself and keep relative URLs.
      publicPath: `${PUBLIC_STATIC_BASE_PLACEHOLDER}/`,
    },
  ];

  for (const page of htmlPages) {
    registerPlugin(
      `HTML -- generates the ${page.filename} file`,
      new rspack.HtmlRspackPlugin({
        filename: page.filename,
        templateContent: renderAppTemplate(page.desc),
        hash: PRODMODE,
        chunks: page.chunks,
        ...(page.publicPath != null ? { publicPath: page.publicPath } : {}),
      }),
    );
  }
}
