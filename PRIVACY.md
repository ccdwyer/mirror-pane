# Privacy

It runs entirely on your machine. It sends nothing over the network. It takes screenshots of the iOS simulator or Android device you choose (with `xcrun simctl` or `adb`), keeps them in `~/.cache/mirror-pane/` (readable only by you; session screenshots older than 7 days are deleted the next time Mirror Pane runs (at a session start or a capture), pinned baselines when replaced), and compares them with ImageMagick if it's installed. Screenshots are never added to the conversation; Claude only gets a one-line note saying how much the screen changed.

The mod collects no analytics or telemetry, and its author receives no data from it.

Questions: https://github.com/ccdwyer/mirror-pane/issues
