#!/usr/bin/env python3
"""End-to-end: real GNOME Shells in a throwaway home, each phase one fresh login.

Touches nothing of the real session: own HOME, dconf, D-Bus and Wayland display. Windows come from
tests/testapp.py so no real app is needed. Run with: python3 tests/e2e.py
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UUID = "savewinplacement@local"
CLI = [sys.executable, str(ROOT / "bin/savewin")]
APP_A, APP_B = "org.savewin.TestA", "org.savewin.TestB"
MONITORS = ["--virtual-monitor", "1600x900", "--virtual-monitor", "1280x720"]


def state_dir():
    return Path(os.environ["XDG_STATE_HOME"]) / "savewinplacement"


def cli_list():
    out = subprocess.run(["gdbus", "call", "--session", "--dest", "org.gnome.Shell", "--object-path",
                          "/io/github/savewinplacement", "--method", "io.github.savewinplacement.List"],
                         capture_output=True, text=True)
    if out.returncode:
        return None
    return json.loads(eval(out.stdout.strip())[0])  # gdbus prints a Python-style tuple


def wait_for(what, condition, timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        result = condition()
        if result:
            return result
        time.sleep(0.5)
    raise SystemExit(f"FAIL timed out waiting for {what}\nlast list: {cli_list()}")


def done_restoring():
    state = cli_list()
    return state if state and not state["restoring"] and state["windows"] else None


def fixture(monitors):
    a, b = monitors  # titles are given out in launch order, so A's entries are deliberately reversed
    entry = dict(fullscreen=False, minimized=False, onAllWorkspaces=False, commandline=[],
                 maximized=dict(horizontal=False, vertical=False))

    def window(app, n, monitor, x, y, w, h, workspace, stack, **extra):
        return {**entry, "appId": f"{app}.desktop", "wmClass": app, "title": f"{app} window {n}",
                "monitor": {k: monitor[k] for k in ("identity", "connector")},
                "rect": dict(x=monitor["x"] + x, y=monitor["y"] + y, width=w, height=h),
                "relative": dict(x=x, y=y), "workspace": workspace, "stack": stack, **extra}

    full = dict(horizontal=True, vertical=True)
    return {"monitors": monitors, "windows": [
        window(APP_A, 1, b, 100, 50, 500, 400, 0, 0),
        window(APP_A, 0, a, 300, 120, 600, 350, 2, 1),
        window(APP_B, 0, b, 0, 0, 640, 480, 0, 2, maximized=full),
        window(APP_B, 1, a, 40, 60, 500, 300, 0, 3, minimized=True),
    ]}


def key(w):
    return w["title"]


def expect_layout(expected, actual, label):
    want, got = {key(w): w for w in expected["windows"]}, {key(w): w for w in actual["windows"]}
    errors = [] if set(want) == set(got) else [f"titles differ: {sorted(want)} vs {sorted(got)}"]
    for title in set(want) & set(got):
        w, g = want[title], got[title]
        fields = ["workspace", "minimized", "maximized", "fullscreen"]
        if not w["maximized"]["horizontal"]:
            fields.append("rect")
        errors += [f"{title}: {f} {g[f]} != {w[f]}" for f in fields if g[f] != w[f]]
        if g["monitor"]["connector"] != w["monitor"]["connector"]:
            errors.append(f"{title}: monitor {g['monitor']} != {w['monitor']}")
    if errors:
        raise SystemExit(f"FAIL {label}\n  " + "\n  ".join(errors))
    print(f"ok {label}")


def phase_restore():
    """First login: no saved session, so nothing happens until a layout is restored by hand."""
    state = wait_for("extension", cli_list)
    if state["windows"]:
        raise SystemExit("FAIL a login with no saved session opened windows")
    expected = fixture(state["monitors"])
    (state_dir() / "manual.json").write_text(json.dumps(expected))
    subprocess.run(CLI + ["restore", "manual"], check=True)
    time.sleep(1)
    expect_layout(expected, wait_for("restore", done_restoring), "manual restore launches and places")
    (state_dir() / "expected.json").write_text(json.dumps(expected))
    wait_for("autosave", (state_dir() / "session.json").exists, timeout=25)
    saved = json.loads((state_dir() / "session.json").read_text())
    expect_layout(expected, saved, "autosave recorded the layout")


def phase_after_reboot():
    """Second login: everything is gone, and comes back with no action from anyone."""
    expected = json.loads((state_dir() / "expected.json").read_text())
    wait_for("extension", cli_list)
    expect_layout(expected, wait_for("auto restore", done_restoring), "login restores the session")

    def toggle(command):
        subprocess.run(["gnome-extensions", command, UUID], check=True, capture_output=True)

    previous = state_dir() / "previous-session.json"
    login_copy_time = previous.stat().st_mtime_ns
    toggle("disable")
    time.sleep(1)
    toggle("enable")
    wait_for("extension back", cli_list)
    time.sleep(6)
    if previous.stat().st_mtime_ns != login_copy_time:
        raise SystemExit("FAIL re-enabling ran the login sequence again")
    expect_layout(expected, cli_list(), "re-enabling mid-session relaunches nothing")
    if not all(m["identity"] for m in cli_list()["monitors"]):
        raise SystemExit(f"FAIL enabling mid-session lost monitor names: {cli_list()['monitors']}")
    print("ok enabling mid-session keeps monitor names")

    subprocess.run(["gdbus", "call", "--session", "--dest", "org.gnome.ScreenSaver", "--object-path",
                    "/org/gnome/ScreenSaver", "--method", "org.gnome.ScreenSaver.Lock"],
                   check=True, capture_output=True)
    time.sleep(3)
    expect_layout(expected, wait_for("locked shell", cli_list), "extension survives the lock screen")


def phase_empty_session():
    """Third login with auto-restore off: nothing opens, yet the last session stays restorable."""
    expected = json.loads((state_dir() / "expected.json").read_text())
    state = wait_for("extension", cli_list)
    time.sleep(3)
    if cli_list()["windows"] or cli_list()["restoring"]:
        raise SystemExit("FAIL auto-restore off still opened windows")
    previous = json.loads((state_dir() / "previous-session.json").read_text())
    expect_layout(expected, previous, "auto-restore off keeps previous-session")
    restore_terminals(state["monitors"])
    terminal_zoom_comes_back()
    restore_calculator(state["monitors"])


def terminal_zoom_comes_back():
    """Each terminal keeps its own font size: zoom two differently, then lose both and restore."""
    def run_action(path, name, *params):
        subprocess.run(["gdbus", "call", "--session", "--dest", "org.gnome.Terminal", "--object-path",
                        path, "--method", "org.gtk.Actions.Activate", name, f"[{', '.join(params)}]", "{}"],
                       check=True, capture_output=True)

    def terminals():
        return [w for w in cli_list()["windows"] if w["wmClass"] == "gnome-terminal-server"]

    def window_paths():
        out = subprocess.run(["gdbus", "introspect", "--session", "--dest", "org.gnome.Terminal",
                              "--object-path", "/org/gnome/Terminal/window"],
                             capture_output=True, text=True).stdout
        return [f"/org/gnome/Terminal/window/{n.split()[1]}" for n in out.splitlines()
                if n.strip().startswith("node ") and n.split()[1].isdigit()]

    def stable_grids():
        def read():
            first = terminals()
            time.sleep(1.5)
            return first if first == terminals() else None
        return wait_for("terminals to settle", read)

    before = {w["rect"]["x"]: w["terminal"] for w in stable_grids()}
    paths = window_paths()
    if len(paths) != 2:
        raise SystemExit(f"FAIL wanted 2 terminal windows, got {paths}")
    run_action(paths[0], "zoom-out")
    run_action(paths[0], "zoom-out")
    run_action(paths[1], "zoom-in")
    time.sleep(2)
    subprocess.run(CLI + ["save", "zoomed"], check=True, capture_output=True)
    saved = json.loads((state_dir() / "zoomed.json").read_text())
    saved["windows"] = [w for w in saved["windows"] if w["wmClass"] == "gnome-terminal-server"]
    (state_dir() / "zoomed.json").write_text(json.dumps(saved))
    if not all(w.get("terminal") for w in saved["windows"]) or len(saved["windows"]) != 2:
        raise SystemExit(f"FAIL grids not saved: {saved['windows']}")
    if not all(w["terminal"]["cwd"] for w in saved["windows"]):
        raise SystemExit(f"FAIL directories not saved: {saved['windows']}")
    home = Path(os.environ["HOME"])
    for window, name in zip(saved["windows"], ("first", "my 100% dir")):
        (home / name).mkdir()
        window["terminal"]["cwd"] = str(home / name)
    (state_dir() / "zoomed.json").write_text(json.dumps(saved))

    for path in paths:
        run_action(path, "close", "<'window'>")
    wait_for("terminals to close", lambda: not terminals())
    subprocess.run(CLI + ["restore", "zoomed"], check=True, capture_output=True)
    time.sleep(1)
    wait_for("zoomed restore", done_restoring)
    time.sleep(1)
    actual = stable_grids()
    if len(actual) != 2:
        raise SystemExit(f"FAIL wanted 2 restored terminals, got {len(actual)}")
    for want in saved["windows"]:
        got = [w for w in actual if abs(w["rect"]["x"] - want["rect"]["x"]) < 30 and
               abs(w["rect"]["y"] - want["rect"]["y"]) < 30]
        if not got:
            raise SystemExit(f"FAIL no terminal at {want['rect']}: {[w['rect'] for w in actual]}")
        if got[0]["terminal"]["cwd"] != want["terminal"]["cwd"]:
            raise SystemExit(f"FAIL directory lost: {got[0]['terminal']} != {want['terminal']}")
        # A window at a default zoom shows a different grid in the same frame.
        cols, rows = want["terminal"]["cols"], want["terminal"]["rows"]
        if abs(got[0]["terminal"]["cols"] - cols) > 3 or abs(got[0]["terminal"]["rows"] - rows) > 2:
            raise SystemExit(f"FAIL zoom lost: {got[0]['terminal']} != {want['terminal']} "
                             f"(frames {got[0]['rect']} {want['rect']}, grids before {before})")
    print("ok terminals get their zoom and directory back")
    for path in window_paths():
        run_action(path, "close", "<'window'>")
    wait_for("terminals to close", lambda: not terminals())


def restore_calculator(monitors):
    """A real app that picks its own size on opening: a saved tile must still win over that.
    The height stays above Calculator's minimum, about 510 at this width."""
    a = monitors[0]
    base = fixture(monitors)["windows"][0]
    window = {**base, "appId": "org.gnome.Calculator.desktop", "wmClass": "org.gnome.Calculator",
              "title": "Calculator", "stack": 0, "workspace": 0,
              "monitor": {k: a[k] for k in ("identity", "connector")},
              "rect": dict(x=a["x"] + 700, y=a["y"] + 300, width=800, height=600),
              "relative": dict(x=700, y=300)}
    expected = {"monitors": monitors, "windows": [window]}
    (state_dir() / "calculator.json").write_text(json.dumps(expected))
    subprocess.run(CLI + ["restore", "calculator"], check=True)
    time.sleep(1)
    actual = [w for w in wait_for("calculator", done_restoring)["windows"]
              if w["wmClass"] == "org.gnome.Calculator"]
    if len(actual) != 1 or actual[0]["rect"] != window["rect"]:
        raise SystemExit(f"FAIL calculator at {[w['rect'] for w in actual]}, wanted {window['rect']}")
    print("ok real app keeps its saved size and position")

    # Below that minimum it can never match: the log has to say so, not count it as placed.
    window["rect"]["height"] = 450
    (state_dir() / "calculator.json").write_text(json.dumps(expected))
    subprocess.run(CLI + ["restore", "calculator"], check=True)
    time.sleep(1)
    wait_for("calculator again", done_restoring)
    log = (Path(os.environ["XDG_RUNTIME_DIR"]) / "phase_empty_session.log").read_text()
    if "1 gave up" not in log or "gave up on Calculator" not in log:
        raise SystemExit("FAIL a window that never fit was counted as placed")
    print("ok restore names a window it could not place")


def restore_terminals(monitors):
    """A real single-instance app: one process, several windows, sized in character cells."""
    # gnome-session does this in a real login; D-Bus starts the terminal server with this environment.
    subprocess.run(["dbus-update-activation-environment", "WAYLAND_DISPLAY=wl-sw"], check=True)
    a, b = monitors
    base = fixture(monitors)["windows"][0]
    spots = [(a, 60, 40, 700, 400, 0), (b, 200, 100, 600, 350, 1)]
    windows = [{**base, "appId": "org.gnome.Terminal.desktop", "wmClass": "gnome-terminal-server",
                "title": "", "stack": i, "workspace": workspace,
                "monitor": {k: monitor[k] for k in ("identity", "connector")},
                "rect": dict(x=monitor["x"] + x, y=monitor["y"] + y, width=w, height=h),
                "relative": dict(x=x, y=y)}
               for i, (monitor, x, y, w, h, workspace) in enumerate(spots)]
    (state_dir() / "terminals.json").write_text(json.dumps({"monitors": monitors, "windows": windows}))
    subprocess.run(CLI + ["restore", "terminals"], check=True)
    time.sleep(1)
    actual = wait_for("terminals", done_restoring)["windows"]
    if len(actual) != 2:
        raise SystemExit(f"FAIL wanted 2 terminals, got {len(actual)}")
    for want in windows:
        match = [g for g in actual if g["rect"]["x"] == want["rect"]["x"] and
                 g["rect"]["y"] == want["rect"]["y"] and g["workspace"] == want["workspace"] and
                 abs(g["rect"]["width"] - want["rect"]["width"]) < 30 and
                 abs(g["rect"]["height"] - want["rect"]["height"]) < 30]
        if not match:
            raise SystemExit(f"FAIL no terminal at {want['rect']}: {[g['rect'] for g in actual]}")
    print("ok single-instance app gets all its windows back")


def run_login(phase):
    shell = subprocess.Popen(
        ["gnome-shell", "--headless", "--wayland", "--no-x11", *MONITORS, "--wayland-display", "wl-sw"],
        stdout=open(Path(os.environ["XDG_RUNTIME_DIR"]) / f"{phase}.log", "w"), stderr=subprocess.STDOUT)
    try:
        globals()[phase]()
        log = (Path(os.environ["XDG_RUNTIME_DIR"]) / f"{phase}.log").read_text()
        errors = [l for l in log.splitlines() if "JS ERROR" in l or
                  ("rror" in l and "[savewinplacement]" in l)]
        if errors:
            raise SystemExit("FAIL shell logged errors\n  " + "\n  ".join(errors[:5]))
    finally:
        shell.terminate()
        try:
            shell.wait(10)
        except subprocess.TimeoutExpired:
            shell.kill()


def setup(base):
    home = base / "h"
    env = {k: v for k, v in os.environ.items() if k not in (
        "DISPLAY", "WAYLAND_DISPLAY", "XDG_SESSION_ID", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP",
        "DESKTOP_SESSION", "GNOME_SHELL_SESSION_MODE", "DBUS_SESSION_BUS_ADDRESS")}
    env.update(HOME=str(home), XDG_CONFIG_HOME=f"{home}/.config", XDG_DATA_HOME=f"{home}/.local/share",
               XDG_CACHE_HOME=f"{home}/.cache", XDG_STATE_HOME=f"{home}/.local/state",
               XDG_RUNTIME_DIR=str(base / "r"), TESTAPP_COUNTER=str(base / "counter"))
    (base / "r").mkdir(mode=0o700)
    for d in (env["XDG_CONFIG_HOME"], env["XDG_CACHE_HOME"], env["XDG_STATE_HOME"]):
        Path(d).mkdir(parents=True)
    apps = Path(env["XDG_DATA_HOME"]) / "applications"
    apps.mkdir(parents=True)
    for app in (APP_A, APP_B):
        (apps / f"{app}.desktop").write_text(
            f"[Desktop Entry]\nType=Application\nName={app}\n"
            f"Exec={sys.executable} {ROOT}/tests/testapp.py {app}\nStartupWMClass={app}\n")
    shutil.copytree(ROOT / "extension" / UUID,
                    Path(env["XDG_DATA_HOME"]) / "gnome-shell/extensions" / UUID)
    # Point this at another installed extension's folder to check that the two get along.
    if env.get("SAVEWIN_E2E_ALSO_ENABLE"):
        other = Path(env["SAVEWIN_E2E_ALSO_ENABLE"])
        shutil.copytree(other, Path(env["XDG_DATA_HOME"]) / "gnome-shell/extensions" / other.name)
    return env


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--login":
        phase = sys.argv[2]
        if phase == "phase_restore":
            extra = Path(os.environ.get("SAVEWIN_E2E_ALSO_ENABLE", "")).name
            enabled = [UUID] + ([extra] if extra else [])
            subprocess.run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", str(enabled)],
                           check=True)
        run_login(phase)
        return
    # Wayland socket paths are limited to 108 bytes, so this cannot live in a deep temp directory.
    base = Path(tempfile.mkdtemp(prefix="swe2e", dir=f"/run/user/{os.getuid()}"))
    try:
        env = setup(base)
        for phase in ("phase_restore", "phase_after_reboot", "config", "phase_empty_session"):
            for f in base.glob("counter*"):
                f.unlink()  # a new login: titles count from 0 again
            if phase == "config":
                state = Path(env["XDG_STATE_HOME"]) / "savewinplacement"
                (state / "config.json").write_text('{"autoRestore": false}')
                continue
            result = subprocess.run(
                ["timeout", "180", "dbus-run-session", "--", sys.executable, __file__, "--login", phase],
                env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            lines = [l for l in result.stdout.splitlines() if l.startswith(("ok ", "FAIL", "  "))]
            print("\n".join(lines))
            if result.returncode:
                for line in (base / "r" / f"{phase}.log").read_text().splitlines():
                    if "[savewinplacement]" in line or "JS ERROR" in line:
                        print("  log:", line[:200])
                if not lines:
                    print(result.stdout[-1500:])
                print("end-to-end test FAILED")
                sys.exit(1)
        print("end-to-end test passed")
    finally:
        shutil.rmtree(base, ignore_errors=True)


if __name__ == "__main__":
    main()
