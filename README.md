# Save Window Placement

Remembers which applications are open and where their windows are, and brings them back after a
reboot: same monitor, position, size, workspace, maximized/minimized state and stacking order.

For Ubuntu 24.04 / GNOME 46 on Wayland. Wayland lets only GNOME Shell see and move other apps'
windows, so this is a Shell extension, with a panel menu and a command line.

## Install

    ./install.sh        # then log out and back in once
    ./install.sh --remove

## Use

It runs by itself: the layout is saved every 15 seconds and restored at login. The panel icon holds
*Restore last session*, *Restore saved layout*, *Save layout now* and the *Restore at login* switch.

    savewin list              # what is tracked now
    savewin save [SLOT]       # save a layout (default slot: manual)
    savewin restore [SLOT]    # default: the desktop as it was at the last login

Layouts are JSON files in `~/.local/state/savewinplacement/`. They contain window titles and
terminal directories.

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
in the pre-commit hook. Work is tracked in `tracker/` (`python3 tools/tracker.py list`).

`install.sh` gives each install its own random UUID. GNOME asks extensions.gnome.org about every
user extension and installs what it offers as an update, so a UUID published here could be taken
over there.
