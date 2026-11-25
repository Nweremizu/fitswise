## What this changes

## How I tested it

<!-- Buds model, Windows version, and what you did. For protocol changes, the recorded bytes behind the new test. -->

- [ ] `pnpm exec tsc --noEmit`, `pnpm build`, `cargo fmt --check` and `cargo test --lib` pass
- [ ] Only opcodes listed in `bt/protocol.rs` are sent, and settings changed while testing were restored
- [ ] New UI works from the keyboard and in light and dark
