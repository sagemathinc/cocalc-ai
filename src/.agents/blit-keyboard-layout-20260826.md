# Blit: non-ASCII keyboard input (ä ö ü ß, AltGr+€) — investigation

Date: 2026-08-26. Branch: `blit-keyboard-layout-20260826`.

Reported symptom: on cocalc.ai, a German-layout user cannot type `ä ö ü ß` or
AltGr+`€` into Blit graphical applications. The same characters reportedly work
when Blit is used outside CoCalc.

## How Blit routes keystrokes (blit 0.55.1, `~/p/blit`)

Blit's compositor ships **one hard-coded XKB keymap**: `crates/compositor/data/us-qwerty.xkb`,
compiled in via `include_str!` (`crates/compositor/src/imp.rs:11788`) and handed
to every Wayland client through `wl_keyboard.keymap` (`imp.rs:8797`). There is no
env var, CLI flag, or config file to change it — `grep -rn keymap crates/` finds
no other source.

Because the keymap is fixed, the browser side resolves the user's layout instead
and splits keystrokes into two channels (`js/core/src/BlitSurfaceCanvas.ts`):

1. **Printable character, no Ctrl/Alt/Meta** → `sendSurfaceText(surfaceId, e.key)`
   (`BlitSurfaceCanvas.ts:4886-4903`). The browser has already applied the German
   layout, so `e.key === "ä"`.
2. **Everything else** (modifiers, arrows, F-keys, Ctrl/Alt/Meta chords) → raw
   evdev keycode derived from `e.code` (physical position).

The compositor then handles channel 1 in `CompositorCommand::TextInput`
(`imp.rs:5243-5300`):

- ASCII that exists on US-QWERTY → `char_to_keycode()` synthesises evdev
  press/release (with a synthetic Shift where needed).
- **Everything else — every non-ASCII character — accumulates into `composed`
  and is delivered only via `zwp_text_input_v3.commit_string()`**
  (`flush_composed`, `imp.rs:2639`).

`flush_composed`'s own doc comment states the consequence plainly:

> Only the characters the keymap cannot express come through here, so a client
> with no enabled input method is no worse off than before: they were dropped
> then and they are dropped now.

So: **a client that has not enabled `zwp_text_input_v3` silently drops every
non-ASCII character.** `ä ö ü ß €` are exactly that set. This explains why all
five fail together and why plain ASCII is unaffected.

(AltGr on Linux browsers does not set `altKey`/`ctrlKey`, so AltGr+E arrives as
`e.key === "€"` and takes the same text path — same failure, same cause.)

## Why this bites CoCalc specifically

CoCalc's integration is the **X11 editor**. `src/packages/project/sea/cocalc-x11`
sets `BLIT_XWAYLAND=1` and requires `xwayland-satellite` + `Xwayland`, and
`blit-applications.ts` offers apps that are X11-only or default to X11 (IDLE/Tk,
xclock, GIMP, Emacs, Qt apps without `QT_QPA_PLATFORM=wayland`).

**Xwayland has no `zwp_text_input_v3` support** — X11 input methods go through
XIM/ibus inside the X world, not through the Wayland protocol. So for any app
reaching the compositor through Xwayland, channel 1 has nowhere to deliver to
and the characters are dropped.

Native Wayland GTK3/GTK4 clients do enable text-input-v3 and should work.
That is the likely reason the same keystrokes work outside CoCalc.

## What this is *not*

- **Not a version skew.** CoCalc pins blit `0.55.1`
  (`src/packages/backend/sandbox/install.ts:142`); `~/p/blit` HEAD is only 7
  commits past `v0.55.1`, none of them keyboard-related.
- **Not a missing user setting.** There is nothing to configure: the compositor
  keymap is compiled in, and the browser already applies the user's real layout.
  A CoCalc "keyboard layout" account setting would have nothing to attach to.
- **Not an iframe/embedding problem.** The text path is a plain `keydown`
  handler inside the iframe's own document; CoCalc's frame editor never sees
  those events.

## The terminal fails too — so there are two causes, not one

Reported second-hand but consistently: `ä` fails in Blit's **terminal** surface
as well as in a graphical window. Those are different code paths, so one cause
cannot explain both.

The terminal never touches the Wayland keymap. `keyToBytes`
(`js/core/src/keyboard.ts:140`) encodes `e.key` as UTF-8 straight to the PTY, so
`ä` reaches the shell as `C3 A4` regardless of any XKB question. What breaks it
downstream is the **locale**: nothing in this repo sets `LANG`/`LC_ALL`/`LC_CTYPE`
(no hits across `src/packages/`), and blit sets no locale either — `session_env`
(`crates/server/src/app_env.rs`) lists display, bus, and audio variables and
nothing about the locale. A project host with no `LANG` runs the shell in
`C`/`POSIX`, where readline defaults `convert-meta` to on and shreds every
multi-byte character. This is the classic "umlauts don't work in a container"
failure, and it is entirely CoCalc's to fix.

The same missing locale independently breaks any app that trusts `LC_CTYPE` for
its input encoding — Tk (IDLE) and Emacs among the launcher's offerings — so it
may account for part of the graphical symptom too.

### Confirmed and fixed (2026-08-26)

`locale` in a terminal on cocalc.ai reports `POSIX` for every category with
`LANG` and `LC_ALL` empty. Fixed by defaulting `LANG` to `C.UTF-8` in
`getEnvironment()` (`src/packages/project-runner/run/env.ts`), which is the env
every container-runtime project process inherits — terminals, Jupyter, and the
Blit server alike. An image naming its own locale keeps it.

Notably the **workspace** runtime was never affected: `INHERITED_ENV_ALLOWLIST`
(`run/workspace.ts:59`) already passes `LANG`/`LC_ALL`/`LC_CTYPE` through from
the host. Only the container path had the gap, which is also why local dev never
reproduced it.

## Correction: blit already prefers Wayland

`toolkit_env` (`crates/server/src/app_env.rs:104`) already exports
`GDK_BACKEND=wayland,x11`, `QT_QPA_PLATFORM=wayland;xcb`,
`SDL_VIDEODRIVER=wayland,x11`, `MOZ_ENABLE_WAYLAND=1` and
`ELECTRON_OZONE_PLATFORM_HINT=wayland` for every app it launches, with Xwayland
as the fallback rather than the destination. So GTK3/GTK4 and Qt apps in CoCalc
are already native Wayland clients and *should* get text-input-v3 — Gnumeric,
Inkscape, LibreOffice, Krita, TeXstudio among them.

That narrows the text-input gap to the genuinely X11-only apps: IDLE (Tk),
xclock, GIMP 2.x (GTK2), and Ubuntu's `emacs-gtk` (X11-only; only the `pgtk`
build speaks Wayland). It also means "export the Wayland hints" is *not* an
available CoCalc-side fix — that work is already done upstream.

## Open questions before proposing a fix

1. **Which** graphical app failed on cocalc.ai. An X11-only one (IDLE, xclock,
   GIMP, emacs-gtk) confirms the text-input gap; a native Wayland one
   (Gnumeric, Inkscape, LibreOffice) refutes it and means something else is
   wrong. `echo "$LANG"` and `locale` in a Blit terminal settles the other half
   in one line.
2. What exactly was run in `~/p/blit`? There is no `target/` build tree and no
   `blit` binary on PATH on this machine, so the local comparison needs pinning
   down before it can be used as a control.

## Upstream

Filed as https://github.com/indent-com/blit/issues/317 (no prior issue existed —
a search of `indent-com/blit` for keymap, xkb, layout, text-input, umlaut,
AltGr, dead key, and plain "keyboard" returned nothing). We are not sending a
PR for it.

## What we fixed on our side

- `LANG` defaults to `C.UTF-8` for container-runtime projects — see above.
- Chromium gains `--enable-wayland-ime`; it binds `zwp_text_input_v3` only when
  Wayland IME support is on, so `--ozone-platform=wayland` alone was not enough.
- Emacs installs `emacs-pgtk` rather than the X11 `emacs-gtk` build.
- Krita and TeXstudio pull `qt6-wayland` and `qtwayland5`. Blit exports
  `QT_QPA_PLATFORM="wayland;xcb"`, and Qt falls back to xcb *without complaint*
  when the Wayland platform plugin is absent — so both were X11 clients despite
  the hint. This was probably the most consequential of the three, since it
  failed silently.

Note the launcher skips installation once an app's executable exists, so a
project that already installed Krita or TeXstudio keeps the old package set.

Left unfixable downstream: IDLE (Tk has no Wayland backend), XClock, and GIMP
2.x on Ubuntu 24.04 (GTK2). These depend on issue 317.

## Candidate fixes (unranked, pending the answers above)

- **CoCalc-side, terminal half:** set a UTF-8 locale for the project runtime
  (`LANG=C.UTF-8` at minimum, always present on Ubuntu without generating
  locales). Fixes the terminal and every locale-sensitive app. Independent of
  everything below and worth doing on its own.
- **Blit-side, complete:** when the focused client has no enabled text-input,
  fall back to the xdotool trick — temporarily bind a spare evdev keycode to the
  needed keysym, push an updated keymap via `wl_keyboard.keymap`, press/release,
  restore. Blit already owns the keymap bytes (`keyboard_keymap_data`), so this
  is a self-contained change. Belongs upstream in `indent-com/blit`.
- **Blit-side, alternative:** make the compiled-in keymap replaceable so a
  session can be started with a German (or any) layout, and have the browser
  send raw keycodes when the local layout matches.
