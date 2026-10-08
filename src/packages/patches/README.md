# Dependency security patches

These patches are applied by pnpm through `patchedDependencies` in
`pnpm-workspace.yaml`. They do not change the upstream package versions or
suppress audit findings. Run `pnpm -C src test:dependency-security` to check the
installed dependencies; this also runs in `test:checks` in CI.

## node-forge 1.4.0

Addresses nested DigestAlgorithm elements accepted during RSA PKCS#1 v1.5
signature verification, [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
The validation change is backported from
[Forge PR #1152](https://github.com/digitalbazaar/forge/pull/1152), head
`ceba34402e329f0365134f23fe19898756527d65`. That PR remains unmerged and npm has
no newer release as of October 8, 2026.

The patch checks the nested algorithm sequence length as well as the outer
DigestInfo length. Tests preserve valid signatures with absent or NULL
parameters, reject extra nested elements, and exercise Lite's self-signed
certificate generation. The workspace patch also covers Expo's Forge copies.

## braces 3.0.3

Mitigates stack exhaustion from deeply nested string patterns,
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
There is no newer npm release as of October 8, 2026; see
[upstream issue #70](https://github.com/micromatch/braces/issues/70).

This local patch bounds parser nesting to 128 brace/parenthesis groups before
recursive compilation or expansion. It respects escaped, quoted, and bracketed
literals and does not limit the number of sibling groups. Excessive nesting
throws `SyntaxError`, like the existing input-length validation. Callers still
must handle invalid patterns; this is not a general sandbox for untrusted
globs or arbitrary caller-supplied ASTs. Tests cover ordinary expansion, both
recursive modes, mixed groups, unclosed groups, literals, and boundary depths.

## Scanner status and follow-up

Version-only scanners still flag patched Forge 1.4.0 and braces 3.0.3. Keep
these findings visible until upstream releases incorporate suitable fixes,
then upgrade, remove the corresponding patch, and rerun the regression tests.
Do not fabricate version numbers or add audit ignore entries to hide them.

The October 8 dependency update also upgrades KaTeX to 0.19.0, compression to
1.8.2, proxy-addr to 2.0.8, source-map-js to 1.2.2, shell-quote to 1.12.0, and
http-cache-semantics to 4.3.0. KaTeX supplies its own declarations, so the older
`@types/katex` packages are removed.

For http-cache-semantics, the
[max-stale advisory](https://github.com/advisories/GHSA-ch52-4w7c-c8xp) lists
versions through 4.2.0, but the
[maintainer disputes it](https://github.com/kornelski/http-cache-semantics/issues/56#issuecomment-5975759591).
Version 4.3.0 fixes a separate Vary-handling issue and falls outside that
advisory's current range. This update is not evidence that max-stale behavior
changed or that a customer-facing cross-user cache existed in CoCalc.
