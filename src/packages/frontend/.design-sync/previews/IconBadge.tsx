import { DSProvider, IconBadge } from "@cocalc/frontend";

// IconBadge — the accent-tinted square that fronts feature/story cards across
// the public site. `icon` is the only required prop; `accent` (hex) and `size`
// (sm/md/lg) are optional. Real icon names + accents pulled from the pages.

export const Default = () => (
  <DSProvider>
    <IconBadge icon="robot" />
  </DSProvider>
);

export const Jupyter = () => (
  <DSProvider>
    <IconBadge accent="#f37726" icon="jupyter" />
  </DSProvider>
);

export const SizeSmall = () => (
  <DSProvider>
    <IconBadge accent="#2f6fda" icon="python" size="sm" />
  </DSProvider>
);

export const SizeMedium = () => (
  <DSProvider>
    <IconBadge accent="#7c3aed" icon="robot" size="md" />
  </DSProvider>
);

export const SizeLarge = () => (
  <DSProvider>
    <IconBadge accent="#389e0d" icon="sagemath" size="lg" />
  </DSProvider>
);
