# Contributing to FitsWise

Thanks for helping. This guide covers setting up, how the code fits together, the rules that keep people's
earbuds safe, and how changes get released.

## Set up

You need Windows 10 or 11 (x64) and:

- [Rust](https://rustup.rs) (stable, 1.90 or later) with the MSVC build tools
- [Node.js](https://nodejs.org) 24 and [pnpm](https://pnpm.io) 11 (`corepack enable` picks up the version in `package.json`)
- Microsoft Edge WebView2, which Windows 11 already has

```powershell
git clone https://github.com/Nweremizu/fitswise.git
cd fitswise
pnpm install
pnpm tauri dev
```

The first build takes a few minutes. For a local release build without the project's signing key, run
`pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'`. You don't need Beats Fit Pro for most UI work (see
[Without earbuds](#without-earbuds)).

## How it fits together

```
src-tauri/src/
  bt/protocol.rs   B2P frames, CRC, parsing. No I/O. Most tests live here.
  bt/link.rs       One RFCOMM connection: typed requests and notifications.
  bt/watcher.rs    Asks Windows whether the buds are paired and connected for audio.
  controller.rs    Owns the buds' state, opens and closes the link, applies changes.
  updates.rs       Signed update checks and installs.
  tray.rs, hotkeys.rs, settings.rs, windows_ui.rs
src/
  app.tsx          Main window: 3D view, battery, noise control, then Settings.
  popup.tsx        The card shown when buds connect.
  components/      battery rings, noise modes, 3D scene, settings rows
  components/ui/   coss ui components (installed with the shadcn CLI; keep edits minimal)
website/           The project site, plain HTML, CSS and JS. Deployed to GitHub Pages.
tools/             Scripts that build the generic 3D model and the app icon.
docs/spec.md       Decisions and everything learned about the protocol.
```

Rust owns all state. Windows are created when opened and destroyed when closed, so the tray app stays at a few
MB. Pages call a handful of commands (`src/lib/api.ts`) and listen for `buds`, `update` and `notice` events.

UI is built with [coss ui](https://coss.com/ui) and a couple of pieces from [devl.dev](https://devl.dev). Add
components with `pnpm dlx shadcn@latest add @coss/<name>`.

## Rules for talking to earbuds

These protect people's hardware. Pull requests that break them won't be merged.

1. **Only send opcodes listed in `bt/protocol.rs`.** Never add firmware, flash, shipping-mode, factory-reset or
   other commands whose effect isn't fully understood, even if the official app has them.
2. **Never take the buds.** Open a link only while `watcher::presence()` says Windows is using them for audio, and
   never retry on a timer after a link closes.
3. **Back findings with recordings.** When you add or change how a report is read, add a test in
   `bt/protocol.rs` that uses bytes recorded from real buds, and note the finding in `docs/spec.md`.
4. **Restore what you change while testing.** Read a setting first and put it back afterwards.

### Recording what the buds send

Development builds (`pnpm tauri dev`) append battery and noise-mode reports to `%TEMP%\fitswise-trace.log`. The
command-line example reads the buds without the app:

```powershell
cd src-tauri
cargo run --example cli                 # status
cargo run --example cli -- battery 60   # watch battery and position reports for 60 s
```

To see what the official Android app sends, turn on **Bluetooth HCI snoop log** in Android's developer options,
use the app, and read the log with Wireshark. Never share logs that contain serial numbers or addresses.

## Without earbuds

`dev/preview.html` runs the real pages in a browser with simulated buds:

```powershell
pnpm dev
# then open http://localhost:1420/dev/preview.html?page=main
```

Useful parameters: `page=main|popup`, `status=connected|disconnected|bluetoothOff|notPaired|unsupported|silent`,
`worn`, `one` (right bud out), `shut` (case lid shut), `case`, `charging`, `left=15`, `update=0.2.0`,
`downloading`, `refuse`, `ask` and `click=Settings`.

## Checks

Run these before opening a pull request. CI runs the same.

```powershell
pnpm exec tsc --noEmit
pnpm build
cd src-tauri
cargo fmt --check
cargo test --lib
```

## 3D model and icon

The public app ships a generic earbuds model (`src/assets/model/buds.glb`) made by
`tools/build_generic_model.py`. Builds with `FITSWISE_PRIVATE=1` use `private/model/` instead, which is
git-ignored. Don't commit models, photos or logos that belong to Apple or Beats.

The icon is rendered from the generic model with Blender (`tools/icon/bud.py`) and finished by
`tools/icon/compose.py`. Then run `pnpm tauri icon src-tauri/icons/source.png`.

## Pull requests

- Keep each pull request to one change, and say how you tested it, on which buds and Windows version.
- Write UI text in plain, short sentences. Say what happened and what to do next.
- Keep accessibility: every control has a name, works from the keyboard, and battery is never shown by colour alone.
- Add or update a test for any logic you change.

## Releases

Maintainers release by bumping `version` in `package.json`, `src-tauri/Cargo.toml` and
`src-tauri/tauri.conf.json`, then pushing a tag:

```powershell
git tag v0.2.0
git push origin v0.2.0
```

The release workflow builds the installer, signs it for the updater with the `TAURI_SIGNING_PRIVATE_KEY` secret,
and publishes it with `latest.json`. Installed copies find it within a few hours.

To test an update locally, build an older version whose updater points at a local feed, for example
`pnpm tauri build --config '{"version":"0.0.9","plugins":{"updater":{"endpoints":["http://127.0.0.1:8123/latest.json"],"dangerousInsecureTransportProtocol":true}}}'`,
and serve a `latest.json` that points at a newer signed installer.

## Code of conduct

Be kind, assume good intent, and keep discussion about the work. Maintainers may remove content or block people who
don't.

## Security

Please report security problems privately through
[GitHub security advisories](https://github.com/Nweremizu/fitswise/security/advisories/new), not in public issues.
