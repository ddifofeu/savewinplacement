# SW-001 Save open apps and window placement, restore them after reboot
kind: change
status: verified
test: tests/e2e.py::login restores the session; tests/e2e.py::single-instance app gets all its windows back; tests/logic.test.js::windows closing at shutdown do not commit
fixed-in: ca6b426
reported: 2026-11-06, owner
blocker: -

## History
- 2026-11-06 open: reported by owner
- 2026-11-06 in-progress: extension, CLI and tests written
- 2026-11-06 fixed: tests pass headless; awaiting a real reboot by the owner
- 2026-11-06 in-progress: real reboot at 14:20: 17 of 18 windows right, zero missing. Calculator came back at 360x503+300+332 instead of 1279x1064+1279+1096, though the log said 18 placed. Same placement mid-session lands and stays, also fresh in a headless login with tilingshell, so the cause is login-only or a later move. Awaiting owner: was it moved by hand?
- 2026-11-06 in-progress: "placed" no longer counts windows that gave up; the log names them with wanted and actual geometry, so the next reboot tells the two causes apart (tests/e2e.py::restore names a window it could not place)
- 2026-11-06 verified: owner moved Calculator by hand after login, so the real reboot restored all 18 windows
