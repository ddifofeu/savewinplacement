# SW-002 Save and restore each terminal's zoom (font size)
kind: change
status: fixed
reported: 2026-11-06, owner
blocker: -
test: tests/e2e.py::terminals get their zoom and directory back; tests/logic.test.js::two steps smaller font
fixed-in: bb13759

## History
- 2026-11-06 open: reported by owner
- 2026-11-06 in-progress: zoom derived from frame / grid, restored with zoom-in/out window actions. Tests pass headless and fail without the fix; uncommitted, needs a real login round
- 2026-11-06 fixed: tests pass headless; awaiting a second real login by the owner
