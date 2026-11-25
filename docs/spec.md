# FitsWise: spec

A small, fast Windows app that controls Beats Fit Pro, with an iPhone-style 3D popup on connect.
Written 2026-11-25 from an interview with the project owner. Status: in progress, see section 12.

Labels used below: **[proven]** seen working on a real pair. **[accepted]** the buds accepted the command with its
current value; a real change is untested. **[from app code]** read from the Android app, never seen on the wire.
**[unknown]** needs investigation.

## 1. Decisions

| Topic | Decision |
|---|---|
| Stack | Tauri 2, Rust, React, Vite, coss.com UI (Tailwind v4, Base UI) |
| Audience | Public release, open source on GitHub, unsigned at first |
| Name | FitsWise: see 9 |
| Devices | Beats Fit Pro only (vendor 0x004C, product 0x2012). Others get "not supported yet" and no commands |
| Main page | 3D model, battery, noise modes only |
| Settings page | Everything else |
| Theme | Follows Windows light/dark, coss neutral styling |
| Popup | Bottom-centre card, on each real connect, info + noise modes, closes itself |
| Fullscreen | Popups stay hidden; the tray still updates |
| Idle | Web view destroyed; only the Rust process stays |
| Connection | Never takes the buds. No auto-connect, no Connect button |
| Startup | Asked once, off by default; switch in Settings and in the tray menu |
| Close button | Hides to tray. Quit is in the tray menu |
| Hotkeys | Full default set on Ctrl+Alt+Shift, tested for conflicts (see 6) |
| Low battery | Small popup at 20% and at 10%, can be turned off |
| 3D model | Public build: generic buds. Private build: detailed model with logos |

Out of scope for v1: drop log, ear tip fit test, tone volume, firmware updates, factory reset, auto-connect, EQ,
other Beats models, macOS/Linux.

## 2. Features

| Feature | Where | Evidence |
|---|---|---|
| Noise cancelling / transparency / off | main, popup, tray, hotkeys | [proven] |
| Left and right battery | main, popup, tray tooltip | [proven] |
| Case battery | main, popup, shown only when reported | [unknown] never reported so far |
| Name shown | main, popup | [proven] |
| Rename | Settings | [accepted] |
| Press and hold, left and right | Settings | [accepted]; left/right order [from app code] |
| Ear detection | Settings | [accepted] |
| Noise control with one bud | Settings | [accepted], set command [from app code] |
| Case colour on the model | main, popup | Colour id reads as 3; meaning of ids [unknown] |
| Bud position animation | main, popup | Investigate, see 7 |
| Choose press-and-hold modes | Settings | Investigate, see 7 |

## 3. UI

Main window: about 380 x 560, fixed size, remembers position.

    My earbuds                [gear] _ x
               [ 3D model ]
          L 85%            R 80%
       [ Noise ][ Transparency ][ Off ]

Settings: same window, back button, sections in this order.

1. Buds: name, left press and hold, right press and hold, ear detection, one-bud noise control
2. Popup: show on connect, low battery alerts
3. Shortcuts: one row per action with recorder, clear and conflict message
4. App: start with Windows, version, licence, "Not affiliated with Apple or Beats"

coss building blocks (fetch `https://coss.com/ui/r/<name>.json`, adapt, do not invent APIs):

| Need | coss | Particle to start from |
|---|---|---|
| Noise modes | radio group as segmented control | p-radio-group-8 |
| Battery | meter | p-meter-2 |
| Settings sections | frame | p-frame-3 |
| Switches | field + switch | p-switch-3 |
| Press and hold | field + select, items-first | p-select-23 |
| Rename | field + input with counter | p-input-18 |
| Shortcuts | kbd | p-kbd-1 |
| First-run startup question | dialog | p-dialog-6 |
| Disconnected / unsupported | empty | p-empty-1 |
| Command failed | toast | p-toast-2 |

coss rules to keep: explicit `type` on every button, `Field` around form controls, `Meter` with custom children must
include its own track and indicator, styled exports before `*Primitive`.

States every screen must handle: Bluetooth off; not paired; paired but not connected ("Connect them in Windows");
connected and loading; connected; busy or no answer; unsupported model; no WebGL (show the poster image).

Behaviour rules
- Controls change at once and roll back with a toast if the buds refuse or do not answer.
- Changes made elsewhere (bud press, phone) update the UI from notifications.
- Choosing volume on one bud gives the other the opposite direction; say so next to the select. Leaving volume
  returns the other bud to its cached action.
- Full keyboard use, visible focus, names on all controls, battery never shown by colour alone.
- `prefers-reduced-motion`: no lid or bud animation, no slide.

## 4. Popup

1. Windows reports the buds connected.
2. Stop if: they were connected within the last 2 minutes, popups are off, the main window is focused, or
   Windows reports a fullscreen app, presentation mode or Do Not Disturb (`SHQueryUserNotificationState`).
3. Create the popup window: bottom centre of the monitor with the pointer, above the taskbar, about 360 x 400,
   transparent, always on top, not in the taskbar, never takes focus.
4. Show a pre-rendered poster immediately, then swap to live 3D: the lid opens while the battery values fade in.
5. Close after 6 s. Hovering or keyboard focus pauses the timer. Esc, the close button or clicking the model ends it;
   clicking the model opens the main window.
6. Destroy the window and web view.

Low battery reuses the card without the 3D animation, once at 20% and once at 10% for the lower bud. Re-arms after that
bud rises 10 points above the threshold.

## 5. Architecture

    Rust process (always on)
      watcher    Windows Bluetooth connection events
      session    one RFCOMM link, protocol, state cache
      tray, hotkeys, settings file, startup entry
         | commands / events
      main window   (created on demand, destroyed on close)
      popup window  (created on demand, destroyed on close)

- One React bundle, two entry pages. Three.js only in a lazily loaded chunk.
- Rust owns all state. Windows ask for a snapshot when they open, then listen for events.
- Single instance; a second launch opens the main window.
- Settings: one JSON file in the app's config folder, written atomically; a bad file falls back to defaults.
- Tauri capabilities kept to the minimum; strict CSP; no network access; no telemetry. Three.js is bundled, not from a CDN.
- Tauri plugins expected: autostart, global-shortcut, single-instance. Check current docs before use.

Not taking the buds (hard rule)
- Open RFCOMM only while Windows already reports the buds connected. Use a direct connection to channel 1, not an
  uncached service lookup, which can itself connect.
- On link loss, close the socket and wait for the next Windows connect event. Never retry on a timer.
- A small race remains: the buds can drop between the check and the open. Use a short timeout and close at once.
- Check which Windows signal means "audio connected" and not merely "some link exists". Our own socket must never
  count as the buds being connected.

Protocol, ported from `beats.py` (its `selftest` frames become the Rust unit tests)
- Frame: `ff b2`, total length u16le, sequence u8, opcode u16le, payload, CRC-32 u32le.
- CRC: poly 04c11db7, not reflected, init 0, inverted output.
- Replies use opcode + 1 and the same sequence; the first reply byte is a status, 0 is success.
- Hello `4000 [00 02]` with sequence ff. Even-opcode frames from the buds are notifications; acknowledge with opcode + 1
  and payload 00.

| Action | Opcode | Payload |
|---|---|---|
| Set noise mode | 415a | mode (0 off, 1 ANC, 2 transparency), 64 |
| Get noise level | 4158 | 01 ANC, 02 transparency |
| Noise notification | 015e | 02, ANC level, transparency level |
| Battery get / notification | 4430 / 0434 | five-byte entries: part (4 L, 2 R, 8 case), 1, percent, state (1 charging, 2 in use, 4 absent), 1 |
| Name get / set | 412c / 4134 | UTF-8, 1 to 32 bytes (our limit) |
| Ear detection get / set | 414c / 414a | 1 on, 2 off |
| Buttons get / set | 446a / 4468 | right, left, cached right, cached left (1 voice, 5 noise, 6 vol up, 7 vol down) |
| One-bud ANC get / set | 447c / 447e | 1 / 0 |
| Bud location get | 4478 | two bytes, see 7 |
| Colour get | 4116 | read 03 00 |

Only the opcodes in this table, plus hello and anything proven in section 7, may be in the code. The Android library also
names flash, firmware, shipping-mode and factory-reset commands: never include them.

## 6. Hotkeys

| Action | Default |
|---|---|
| Noise cancelling / transparency / off | Ctrl+Alt+Shift+1 / 2 / 3 |
| Open FitsWise | Ctrl+Alt+Shift+B |

Tested 2026-11-25 on the development PC: all four are free as global hotkeys. Limits and rules:
- On some layouts AltGr+Shift equals Ctrl+Alt+Shift and may type characters. On startup and on layout change, check each
  installed layout with `ToUnicodeEx`; if a key types anything, leave that shortcut unset and say why.
- If registration fails, leave that shortcut unset and show "Already used by another app". Never fail silently.
- Shortcuts used only inside another app cannot be detected, and a global hotkey would override them. So: list the
  defaults on first run, allow each to be changed or cleared, and provide one switch to turn all off.

## 7. Investigations, before their UI is built

| Item | Known | Test | If it fails |
|---|---|---|---|
| Bud location (4478) | Read `01 01` in the phone capture and `00 03` on the PC later | Read in five states: both worn, one out, both on the table, one in the case, both in the case lid open. Look for notifications | Keep buds seated in the model, no fake motion |
| Press-and-hold modes (418a get, 418c set) | Reads `06`; probably bit 0 off, bit 1 ANC, bit 2 transparency | Write one change, test with a real press, restore | Leave out of v1 |
| Left/right order of buttons | From app code | Set left to noise control, press left | Swap the order |
| Colour ids | This pair is 3 | Ask owners of other colours | One neutral finish |
| Phone and PC at once | Untested | Both apps open; change settings on each | Document the limit |

Every write test records the old value first and restores it.

## 8. Size and speed budgets (targets to measure, not promises)

| Measure | Target |
|---|---|
| Installer | 12 MB or less |
| Idle memory, tray only | 25 MB or less private working set |
| Idle CPU | 0% average |
| Connect event to poster visible | 700 ms or less |
| Connect event to live 3D | 1.5 s or less |
| Noise mode click to acknowledged | 200 ms typical |
| Model file | 800 KB or less (now 5.2 MB, 215k triangles: reduce and compress) |

If "poster visible" misses its target, revisit the choice to free memory when idle.

## 9. Release, legal and privacy

- **Name:** on 2026-11-25 a web search found no FITSWISE trademark and no GitHub repository of that name. Similar FITWISE
  marks exist for bedding, pharmaceuticals and (cancelled) clothing; none found for software. Not a formal clearance: search
  USPTO classes 9 and 42 and the Microsoft Store before release. Keep the name in one constant. (Budwise was dropped: a
  filing covers mobile apps and software.)
- **Two builds:** the public repo contains only the generic model. The detailed model and logos stay in an ignored
  `private/` folder used by a private build flag.
- **Never publish:** `model/ref` (another seller's renders), `model/comparison.png`, the detailed GLB and viewer, Bluetooth
  captures, the Android app or its decompiled code, or any serial number.
- Describe as "works with Beats Fit Pro", with a "not affiliated with Apple or Beats" notice. This is not legal advice.
- Publish hashes with each release and build it in GitHub Actions. Expect a SmartScreen warning while unsigned.
- No accounts or analytics. The only network call is the update check: `latest.json` on the newest GitHub release,
  signed with a key kept outside the repository (CI secret `TAURI_SIGNING_PRIVATE_KEY`). The user confirms each install.

## 10. Build order and acceptance

1. **Rust core.** Protocol tests pass on the recorded frames; a small command-line build reads status and sets noise modes.
2. **Connection watcher.** With buds on the phone, running FitsWise for 30 minutes never moves them. With buds on the PC,
   opening and quitting FitsWise ten times causes no disconnect.
3. **Tray, startup, hotkeys.** Startup entry appears and disappears from all three switches; conflicts are reported.
4. **Main and Settings.** All states in section 3 reachable; every setting changed for real, read back and restored.
5. **Popup.** Right place at 100%, 125% and 150% scaling and on a second monitor; never takes focus; hidden in fullscreen;
   quiet after a short drop.
6. **Models.** Generic model made; both compressed; posters rendered for light and dark.
7. **Investigations** from section 7, then their UI if they pass.
8. **Budgets** measured on the development laptop and written into the README. Eight hours in the tray without a leak or a drop.

## 11. Assumptions to confirm

- One main page plus a separate Settings page inside the same window.
- Windows 11 and Windows 10 22H2, x64 only.
- MIT licence.
- The detailed 3D model is known to be off in places; refining it is later work.

## 12. Findings while building (2026-11-25)

- **Battery:** the report ends with a group that is not a battery (second byte 0). In the case it is `02 00 ff 02 02`; reading it
  as a battery hid the right bud. Case battery is proven: it appears when the buds are in the open case.
- **Bud location:** comes at the end of every battery report: `[lid, 0, ff, left, right]`, 2 = in the case. Fixed sides. The buds never
  sent location notifications (047a), and 4478 orders by primary/secondary, so neither is used. During a hand-over the sides can be
  swapped for about 30 ms; a swap is believed only if the buds repeat it when asked.
- **Unknown readings:** a bud can report `ff 03` (and the case `00 03`) while buds move, sometimes without a later correction. A seated part
  keeps its level and charging state, and the app asks again every 1.5 s, up to 8 times.
- **Confirmed on the development build:** correct bud animates, all three noise modes, charging symbol stays.
- **Noise modes in the case:** the buds accept the command but keep their mode. The app confirms by reading back.
- **Press-and-hold modes (418a/418c):** not investigated yet.
- **UI:** Liquid Segments and Liquid Switch from devl.dev (MIT), grouped rows after its Security Settings screen.
- **Measured (release, private model):** exe 3.3 MB. Tray only: about 6 MB private, 0% CPU over 10 s (build before the redesign).
  Popup visible 445 to 526 ms after the request, first 3D frame not timed. Models 553 KB and 306 KB.
- **Not taking the buds:** ten start/stop cycles with the buds connected caused no audio drop. Not yet tested: 30 minutes with the
  buds on a phone; popup on a real connect; hotkeys; fullscreen; other scalings; real changes to buttons, ear detection, one-bud and
  name; eight hours in the tray.
- **Ear position (4478):** 0 in ear, 1 out, 2 in case, primary then secondary. The battery report only tells in case (2) from not (1).
- **Mode get (4158):** answered "off" while noise cancelling was on and the primary bud was not in an ear. Confirm from 015e instead.
- With neither bud sensed in an ear, the buds turn noise control off by themselves after 1 to 15 s. With one sensed, it stays on.
