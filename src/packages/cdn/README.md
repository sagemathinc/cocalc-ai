# Webapp CDN files

These packages

- katex
- codemirror

## Why?

This directory contains additional resources for at least the `/index.html` and `/app` page. Many of these were served directly from CDN's before. However, that introduces a dependency where [CoCalc.com](http://CoCalc.com) can't load unless all these random CDN's also work... and that is unacceptable for two reasons:

1. If any of these CDN's go down, [CoCalc.com](http://CoCalc.com) would get mangled or not load. That's no good.
2. If you use a private install of cocalc on a computer that doesn't have network access, it doesn't work at all ever. That's definitely not good.

## IMPORTANT: How do I update a package version?

Update `package.json` as usual, then run `pnpm install` from
`src/packages` so the workspace lockfile is updated. The build script copies
the resolved pnpm workspace packages into `dist` and writes the version map
used by the frontend build.

## How to build?

Run `pnpm run build`. The build script copies the relevant package files into
`dist`, creates versioned symlinks such as `codemirror-<version>`, copies the
custom CoCalc CodeMirror themes, and writes `dist/index.js`.

## Notes

Other files in `packages/assets` might not be used any more. At some point we can clean them up.

We have to run a postinstall script to create the versioned symlinks, since -- to be cross platform -- npm itself [doesn't support symlinks](https://npm.community/t/how-can-i-publish-symlink/5599).
