# SW-003 Reopen each terminal in the directory it was in
kind: change
status: in-progress
reported: 2026-11-06, owner
blocker: -
test: tests/e2e.py::terminals get their zoom and directory back; tests/logic.test.js::terminals pair by directory
fixed-in: -

## History
- 2026-11-06 open: reported by owner
- 2026-11-06 in-progress: shell cwd saved, terminals launched with --working-directory and matched by directory. Tests pass headless and fail without the fix; uncommitted, needs a real login round
