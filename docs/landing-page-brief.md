# CoCalc.ai Landing Page — Brief

> North star for the public landing page. Fits on one screen on purpose.
> Status: **PROPOSED REVISION — awaiting Blaec's sign-off.** Supersedes the FROZEN 2026-06-17
> version on approval. Grounded in a full read of `docs/pitch/` (not a paraphrase); holds two
> founder constraints: (1) keep the continuity-benefit hero; (2) foreground research +
> research-automation as the primary proof. Changing the promise or primary CTA requires
> Blaec's sign-off + a note in the decisions log.

## The one promise (hero)

**Make computational work easier to share, review, and continue.**

This is the headline idea — a benefit, not a category. The pitch's category line,
*"AI-native technical workspace,"* is the **eyebrow / supporting** frame, **never the H1**.
Workspace, AI, and deploy-anywhere are *proof of the promise*, never the headline.
**The current home page (including its audience-oriented hero) is considered good by Blaec and
is NOT slated for overhaul — he iterated it heavily.** Do not rewrite the home hero without
his explicit ask; the remaining work is the *rest* of the site.

## Who the page is for (priority order)

1. **Research labs, R&D and engineering groups, and advanced technical teams** (the users —
   co-primary in the pitch). Arrive asking: *"Will this fit how my team actually works, and
   can we pick up each other's work?"* Routed to the reproducible-collaboration + reviewability
   proof.
2. **Executive / operating-model decision-makers** (procurement / sponsor — the buyer).
   Arrive asking: *"Which operating model and price fits us, and can we run it our way?"*
   This is an operating-model/procurement buyer — **NOT** a university-IT or LMS-integration
   buyer. Routed to *Compare operating models*.

**Teaching/courses are a valued audience AND a deliberate adoption pipeline** — a large
existing cocalc.com revenue stream and a top-of-funnel that turns students into the
researchers and engineers we sell to (the MATLAB academic-to-industry land-and-expand model).
Present and respected on the page; the *enterprise sales* framing leads with research/R&D, but
teaching is never buried or erased. IT/platform is a supporting buyer-stakeholder, routed off
the primary user proof.

## The page's job

State the promise → prove it (research-forward) → route to the right operating model → drive
ONE action.

## Proof spine (research-forward, in order of altitude)

1. **Reproducible, continuable technical work** — work lives in one shared, persistent
   project; reproducible collaboration across notebooks, code, documents, and compute that
   any teammate — *or a long-running / scheduled task* — can pick up and continue without
   rebuilding context (history, snapshots, backups, project moves stay close to the work).
2. **Reviewable & recoverable** — technical work can be inspected before handoff and
   recovered in practice. *Qualitative only — no measured restore times, audit coverage, or
   rollback guarantees.*
3. **Deploy anywhere** — the same workspace runs hosted (CoCalc.ai), local (Plus), single-VM
   (Star), private team (Launchpad), or self-operated enterprise (Rocket); operator boundary
   explicit. **Ranked third for the user; routed to the decision-maker.**

Automation / the CLI / the HTTP API appear ONLY as a **proof surface with concrete workflow
examples** — never a headline, hero, or CTA, never a top-level buying path (doc 16 §9). Since
no automation demo is validated yet, examples describe the workflow *shape*, not throughput
or outcomes.

## The one primary CTA

**Start on CoCalc.ai** (sign up) — single obvious action, repeated at most twice (hero +
close). Secondary: **Compare operating models** (decision-maker). Tertiary: feature/product
links, present but never competing for the eye.

## Hard "do nots"

- No tool-inventory headlines ("notebooks, code, documents, compute, AI…"). (Naming the core
  audiences — research, teaching, technical teams — in a hero is fine; it reflects the real
  user base and the teaching pipeline.)
- No **category collapse**: not "AI IDE", "notebook platform", "cloud coding agent",
  "sandbox/runtime API", "prompt-to-app", or "sovereign cloud".
- No "**serious technical work**" or tacky/exclusive phrasing; no empty phrases (world-class,
  AI-powered, enterprise-ready, seamless, cutting-edge). *(Founder override: the pitch uses
  "serious technical work"; Blaec banned it — the ban wins.)*
- CoCalc Plus is **"source-available,"** never "open source"; no zero-telemetry / air-gapped /
  sovereign claims.
- No managed-hosting, named-SLA, or vendor-operated implication for Launchpad/Rocket; keep the
  operator boundary explicit. No automatic-migration language (the hosted transition is
  user-directed export/download).
- Do not elevate automation / CLI / HTTP API to a headline or primary CTA.
- No invented metrics, customer proof, benchmark numbers, or setup/restore/deploy timing
  claims; human review is never optional. Don't repeat the same idea across sections.
- No autonomous open-ended "iterate" runs on this page.

## Language & approval notes

- **Launch-safe** now: the category (as support), one-workspace breadth (with mechanism),
  qualitative reviewability/recoverability, the five-path deploy ladder, Plus source-available,
  site licensing as the organizational wrapper.
- **Sales-only / contract-dependent** (keep off public copy): named SLAs, exact scale/capacity,
  pricing/entitlement detail, implementation scope, managed-operations implications,
  HPC/sovereign/government claims. Anonymous "research institutions / research labs / R&D
  groups" references are OK; named customers and "government research settings" are not (yet).
- Stronger trust/competitor/metric wording routes through the approval chain: Blaec
  (messaging) → Andrey (trust/compliance) → William (technical/benchmark).

## Done means

- The promise is clear in one sentence, above the fold; research/R&D leads feel it's for them.
- The page reads as **one argument with one obvious next step** — no idea repeats; teaching/IT
  stay secondary.
- It looks **intentionally designed**, not assembled (consistent rhythm, type, color — D1).
- A single word can change in under a minute without editing a test (C1).
- The team is proud to ship it.
