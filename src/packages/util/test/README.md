# Utility tests

This directory contains active TypeScript Jest tests. They are discovered by
`../jest.config.js` along with other `*.test.ts` and `*.spec.ts` files in the
package. From `src/packages/util`, with workspace dependencies installed:

```sh
pnpm test --runInBand test/defaults.test.ts
```

Use the package test configuration when adding or changing these tests. Some
older filenames remain, but this directory is not unused.
