# SW-001 Save open apps and window placement, restore them after reboot
kind: change
status: fixed
test: tests/e2e.py::login restores the session; tests/e2e.py::single-instance app gets all its windows back; tests/logic.test.js::windows closing at shutdown do not commit
fixed-in: ca6b426
reported: 2026-11-06, owner
blocker: -

## History
- 2026-11-06 in-progress: extension, CLI and tests written
- 2026-11-06 fixed: tests pass headless; awaiting a real reboot by the owner
- 2026-11-06 open: reported by owner
