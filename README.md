# Mirror Pane

A Claude Code mod that gives you visual feedback on the same step as a UI edit.

When Claude edits a UI file, Mirror Pane screenshots your iOS simulator or Android emulator just before the edit. It waits for hot reload, takes a second screenshot, and shows the two side by side in a pane. If ImageMagick is installed, it also reports what share of pixels changed (beyond a small colour tolerance). Claude gets a one-line note with that number and a caveat that clocks, spinners or a slow reload can affect it, so it knows a visual check happened. The note never includes the image itself.

- **Which edits:** `.tsx`, `.jsx`, `.swift`, `.dart`, `.css`/`.scss`/`.less`, `.vue`, `.svelte`, storyboards/xibs, Android layout, drawable and colour/theme XML, Compose `.kt` under `ui/`, `screens/` or `components/`, and `.ts`/`.js` under `components/`, `screens/`, `app/`, `ui/`, `views/` or `pages/` inside the project. Tests, stories, `Package.swift` and `app/api/` routes are skipped. Add more in the plugin settings (`extraPatterns`).
- **Which device:** the one you pick with `/mirror device <udid|serial>`, or else the only booted simulator or `emulator-*`. A physical Android phone is only ever used when you pick it, since its screen can show notifications. If several are running, it never guesses; it tells you once to pick.
- **Busy or silent devices:** one capture runs per device at a time, across all your Claude Code sessions. An edit that would have to wait more than a few seconds just goes through without screenshots. A device that stops answering is paused for 5 minutes, with one hint.
- **Baselines:** `/mirror baseline` pins the current screen as known-good for that file. Later edits also report drift against it.
- **History:** the pane keeps the last 10 before/after pairs (configurable), with prev/next buttons.

## Commands

```
/mirror                     open the pane
/mirror on | off            turn captures on or off
/mirror device <id|auto>    choose the simulator (UDID) or Android device (adb serial)
/mirror baseline            pin the current screen as the baseline for its file
```

## Requirements

- **Images in the pane** need a terminal with the kitty graphics protocol (kitty, Ghostty). Elsewhere the pane shows the screenshot paths as text, and the band and the note to Claude still work.
- **iOS:** Xcode's `xcrun simctl`. **Android:** `adb`.
- **Changed-pixel percentage:** ImageMagick (`brew install imagemagick`). Without it, captures still happen and the percentage is left out.

Settings (`/plugin configure mirror-pane@ccdwyer-mods`): `delayMs` (hot-reload wait, default 2000, at most 5000), `noteToModel`, `extraPatterns`, `historySize`.

## Install

```
/plugin marketplace add ccdwyer/claude-mods
/plugin install mirror-pane@ccdwyer-mods
/reload-plugins
```

## Develop

```
claude plugin validate .
claude plugin test .
```

## What it hooks

Events this mod hooks, as `claude plugin validate` reads the module:

- `session.start`
- `command.run{command=mirror}`
- `tool.call`
- `ui.render{component=Pane, requestId=mirror-pane}`
- `ui.render{component=AbovePrompt}`

A `tool.call` hook sits in the middle of every tool call: it can see the call, refuse it, or add context to its result. This mod never refuses anything; it only adds the one-line note to UI edits.

## Privacy

It runs entirely on your machine and sends nothing over the network. Screenshots stay in `~/.cache/mirror-pane/` (readable only by you, and screenshots older than 7 days are deleted the next time Mirror Pane runs, except pinned baselines), and only a one-line note reaches Claude.

Full policy: [PRIVACY.md](PRIVACY.md).

## License

MIT
