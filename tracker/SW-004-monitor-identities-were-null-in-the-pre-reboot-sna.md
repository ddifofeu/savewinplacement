# SW-004 Monitor identities were null in the pre-reboot snapshot
kind: bug
status: open
reported: 2026-11-06, claude
blocker: -
test: -
fixed-in: -

## History
- 2026-11-06 open: reported by claude
- 2026-11-06 open: previous-session.json had identity null on both monitors with connectors present; no "no monitor names" in the log. Restore still worked through the connector, but a monitor moved to another port would not match. Enabling mid-session ruled out (tests/e2e.py::enabling mid-session keeps monitor names). Next: check identities in previous-session.json after the next reboot; shutdown-time capture is the remaining suspect
