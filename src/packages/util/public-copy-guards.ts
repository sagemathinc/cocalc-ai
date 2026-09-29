/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Copy guards for the public marketing pages. The frontend tests check the
// rendered React pages and the hub test checks the crawler fallback HTML from
// public-prerender.ts against these same lists.

// Internal/implementation language that must never leak into public copy.
// The hub test checks title, description and H1; the React tests check
// metadata and, on Home, the full text.
export const INTERNAL_IMPLEMENTATION_TERMS =
  /serious\s+technical\s+work|project hosts|backend state|logs stay scoped|RootFS|multi-bay|control plane|postgres|kubernetes|systemd|conat/i;

export const OVERPROMISE_TERMS =
  /with Lima|source[- ]available|multi[- ]?VM|broader deployment rights|FedRAMP|\bATO\b|SOC 2[- ]certified|HIPAA[- ]compliant|FERPA[- ]compliant|\bunlimited\b|\bguarantee(d|s)?\b/i;

// "default Octave kernel" used to live here: no Octave image existed, so the
// claim was false. The octave-11-3 image ships Octave as its default Jupyter
// kernel, so the octave page may say so now.
export const UNSUPPORTED_CAPABILITY_TERMS =
  /built-in scheduler|recurring runs?|preinstalled (language stack|C\+\+|Fortran|Rust)/i;

// Dollar amounts belong on the pricing page only.
export const DOLLAR_AMOUNT = /\$\s*\d/;

// Stale descriptions of agents. Claude Code is an integrated agent
// (experimental preview), so copy must not list it among the terminal-only
// agents; running it in a terminal is still possible, so a plain mention of
// a terminal is allowed. Agents change project files as they work, with no
// separate step that keeps or discards the work.
export const STALE_AGENT_PHRASES =
  /Claude Code in a terminal, or other shell|Claude Code(,| and| or) (OpenCode|other (shell|command-line|terminal))|terminal-(native|based) agents such as Claude Code|before keeping it/i;
