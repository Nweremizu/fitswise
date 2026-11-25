# FitsWise

A small Windows app for Beats Fit Pro: battery, noise control, press-and-hold, ear detection and renaming, with a 3D view and a
popup when the buds connect. Built with Tauri 2, Rust, React, Vite and [coss ui](https://coss.com/ui).

Works with Beats Fit Pro. Not affiliated with Apple or Beats.

## Develop

```powershell
pnpm install
pnpm tauri dev                                  # generic 3D model
$env:FITSWISE_PRIVATE='1'; pnpm tauri dev       # detailed model from the git-ignored private folder
cd src-tauri; cargo test --lib                  # protocol tests, using frames recorded from real buds
cargo run --example cli -- battery 30           # read the buds without the app
```

`dev/preview.html` runs the pages in a browser with simulated buds. See `docs/spec.md` for decisions and findings.
