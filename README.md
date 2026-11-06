# Save Window Placement

Remembers which applications are open and where their windows are, and brings them back after a
reboot: same monitor, position, size, workspace, maximized/minimized state and stacking order.

For Ubuntu 24.04 / GNOME 46 on Wayland. Wayland lets only GNOME Shell see and move other apps'
windows, so this is a Shell extension, with a panel menu and a command line.

## Status

A small personal utility, written and tested on one desktop in November 2026.

- **Real reboot:** on 2026-11-06, all 18 open windows came back ([SW-001](tracker/SW-001-save-open-apps-and-window-placement-restore-them-a.md)).
- **Waiting on a real login:** terminal zoom and directory restore pass the headless tests, but a
  second real login hasn't confirmed them yet ([SW-002](tracker/SW-002-save-and-restore-each-terminal-s-zoom-font-size.md), [SW-003](tracker/SW-003-reopen-each-terminal-in-the-directory-it-was-in.md)).
- **Open bug:** monitor names were missing from one pre-reboot snapshot. Restore still worked through
  the connector, but a monitor moved to another port wouldn't have matched ([SW-004](tracker/SW-004-monitor-identities-were-null-in-the-pre-reboot-sna.md)).
- **Not tested:** other GNOME versions (the extension declares 46 only), other distributions, and X11.

## Install

    ./install.sh        # then log out and back in once
    ./install.sh --remove

## Use

It runs by itself: the layout is saved every 15 seconds and restored at login. The panel icon holds
*Restore last session*, *Restore saved layout*, *Save layout now* and the *Restore at login* switch.

    savewin list              # what is tracked now
    savewin save [SLOT]       # save a layout (default slot: manual)
    savewin restore [SLOT]    # default: the desktop as it was at the last login

Layouts are JSON files in `~/.local/state/savewinplacement/`. They contain window titles, terminal
directories and, for apps without a .desktop file, the command line that gets relaunched. Treat them
as private, and as trusted input: restoring a layout runs those commands.

## What comes back, and what does not

- **Browsers** (Brave, Chrome and relatives) start with `--restore-last-session`, so their tabs come
  back, and windows are told apart by title. Chromium decides which windows it reopens; any it
  doesn't are listed in a notification.
- **GNOME Terminal** windows come back in the directory their shell was in and at their zoom. They
  are fresh shells: running programs and scrollback do not return. While any terminal has tabs or
  is held open after its shell exited, all terminals keep their place only: nothing links a shell
  to its window, so they are paired by count.
  Minimized terminals keep their directory but not their zoom.
- **Other apps** reopen the right number of windows, but their contents are up to them. Files opens
  at Home.
- **Apps without a .desktop file** are relaunched from the command line they ran with.

## How saving stays safe

- Windows close one by one during shutdown, so autosave ignores a lower window count until it has
  lasted 45 seconds. A desktop you really did close down is saved after that.
- Autosave ignores layouts with fewer monitors than the saved one: a sleeping monitor pushes windows
  onto the other screen. After removing a monitor for good, run `savewin save session`.
- `previous-session.json` is copied at login, before anything else can change `session.json`.

## Development

    gjs -m tests/logic.test.js   # decisions: matching, placement, when to save
    python3 tests/e2e.py         # real headless GNOME Shells with two virtual monitors, one per login

The end-to-end test uses a throwaway home and D-Bus, so it never touches the running desktop. Set
`SAVEWIN_E2E_ALSO_ENABLE=<extension folder>` to run it alongside another extension. Both tests run
in the pre-commit hook for changes to the extension or tests. Work is tracked in `tracker/`
(`python3 tools/tracker.py list`). Both tests passed on 2026-11-06 at commit `6b4a00b` with GNOME
Shell 46.0.

`install.sh` gives each install its own random UUID. GNOME asks extensions.gnome.org about every
user extension and installs what it offers as an update, so a UUID published here could be taken
over there.

## Design and contribution

I set the requirements for this tool, which are recorded as owner requests in `tracker/`: saving and
restoring window placement, then terminal zoom and directory. I also did the real-reboot check. When
one window looked wrong after that reboot, the logs couldn't tell a failed placement from a later
move, so the restore log was changed to name windows it couldn't place. I then confirmed I had moved
that window by hand.

The implementation is AI-assisted: every commit carries a Claude co-author trailer.
