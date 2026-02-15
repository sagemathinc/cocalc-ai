/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import NextHead from "next/head";
import { join } from "path";
import { ReactNode } from "react";

import ROOT_PATH from "lib/root-path";
import { useCustomize } from "lib/customize";
import IconLogo from "public/logo/icon.svg";

interface Props {
  title: ReactNode;
}

export default function Head({ title }: Props) {
  const { siteName, logoSquareURL } = useCustomize();

  const faviconURL = logoSquareURL
    ? logoSquareURL
    : join(ROOT_PATH ?? "", IconLogo.src);

  const feedTitle = `${siteName}'s News Feed`;

  // This shows the title if given, otherwise the siteName.
  // It used to always show the sitename first, but that's
  // mostly useless, the site is clear already from the favicon,
  // and other sites like github and amazon do NOT do that.
  return (
    <NextHead>
      <title>{`${title ? title : siteName}`}</title>
      <meta
        name="description"
        content="CoCalc landing pages and documentation"
      />
      <link rel="icon" href={faviconURL} />
      <link
        rel="alternate"
        type="application/rss+xml"
        href={join(ROOT_PATH, "/news/rss.xml")}
        title={feedTitle}
      />
      <link
        rel="alternate"
        type="application/feed+json"
        href={join(ROOT_PATH, "/news/feed.json")}
        title={feedTitle}
      />
      <link
        rel="alternate"
        type="application/atom+xml"
        href={join(ROOT_PATH, "/news/rss.xml")}
        title={feedTitle}
      />
    </NextHead>
  );
}
