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
                ["timeout", "120", "dbus-run-session", "--", sys.executable, __file__, "--login", phase],
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
