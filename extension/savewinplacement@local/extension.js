// Saves open applications and their window placement; brings them back at login or on request.
// On Wayland only code inside GNOME Shell can see or move other applications' windows.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import * as Logic from './logic.js';

const AUTOSAVE_SECONDS = 15;
const RESTORE_TICK_MS = 1000;
const RESTORE_DEADLINE_MS = 120000;
// Quiet time after an app's window count last changed: browsers open windows in bursts, and need a
// moment to set titles, which is what tells their windows apart.
const SETTLE_MS = 4000;
const PLACE_MAX_TRIES = 6;
// Apps like Brave move their own window just after mapping it, so one correct reading is not enough.
const PLACE_STABLE_TICKS = 2;
// Cell sizes are whole pixels, so a zoom can land a step off; the next round corrects it.
const ZOOM_MAX_ROUNDS = 3;

const DBUS_PATH = '/io/github/savewinplacement';
const DBUS_XML = `<node>
  <interface name="io.github.savewinplacement">
    <method name="Save"><arg type="s" direction="in" name="slot"/><arg type="u" direction="out" name="windows"/></method>
    <method name="Restore"><arg type="s" direction="in" name="slot"/><arg type="b" direction="out" name="started"/></method>
    <method name="List"><arg type="s" direction="out" name="json"/></method>
  </interface>
</node>`;

const decoder = new TextDecoder();

// Survives disable/enable, which the shell may do in one login; only a new login reloads the module.
let loginHandled = false;

function log(message) {
    console.log(`[savewinplacement] ${message}`);
}

function isSavable(window) {
    return window.get_window_type() === Meta.WindowType.NORMAL &&
        !window.is_skip_taskbar() && !window.get_transient_for() &&
        !(window.get_title() ?? '').startsWith('@!'); // the desktop-icons extension's own window
}

function savableWindows() {
    const windows = global.get_window_actors().map(a => a.get_meta_window()).filter(isSavable);
    return global.display.sort_windows_by_stacking(windows);
}

function realAppId(window) {
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    return app?.get_app_info() ? app.get_id() : null;
}

function windowGroupKey(window) {
    return Logic.groupKey(realAppId(window), window.get_wm_class());
}

function readCommandline(pid) {
    try {
        const [ok, bytes] = GLib.file_get_contents(`/proc/${pid}/cmdline`);
        return ok ? decoder.decode(bytes).split('\0').filter(Boolean) : [];
    } catch {
        return [];
    }
}

function maximizedFlags(window) {
    const flags = window.get_maximized();
    return {
        horizontal: (flags & Meta.MaximizeFlags.HORIZONTAL) !== 0,
        vertical: (flags & Meta.MaximizeFlags.VERTICAL) !== 0,
    };
}

function terminalShells(pid) {
    const shells = [];
    const dir = GLib.Dir.open(`/proc/${pid}/task`, 0);
    for (let task = dir.read_name(); task; task = dir.read_name()) {
        const [, bytes] = GLib.file_get_contents(`/proc/${pid}/task/${task}/children`);
        for (const child of decoder.decode(bytes).trim().split(/\s+/).filter(Boolean)) {
            const pty = GLib.file_read_link(`/proc/${child}/fd/0`);
            if (pty.startsWith('/dev/pts/'))
                shells.push({pid: Number(child), pty, cwd: GLib.file_read_link(`/proc/${child}/cwd`)});
        }
    }
    return shells;
}

// Character grid and shell directory of each terminal window. Blocking costs about 2 ms and spares
// the save and restore paths a callback. LEAVE_DESCRIPTORS_OPEN is what keeps it there: it lets GLib
// use posix_spawn, where a plain spawn forks all of gnome-shell, on this thread sync or not.
function terminalGrids(windows) {
    const found = new Map();
    const terminals = windows.filter(w => Logic.isTerminal(w.get_wm_class()));
    try {
        for (const pid of new Set(terminals.map(w => w.get_pid()))) {
            const pairs = Logic.pairTerminals(
                terminals.filter(w => w.get_pid() === pid)
                    .map(window => ({window, path: window.get_gtk_window_object_path() ?? ''})),
                terminalShells(pid));
            if (!pairs.length)
                continue;
            const script = 'for p; do echo "$p $(stty -F "$p" size 2>/dev/null)"; done';
            const [, out] = GLib.spawn_sync(null,
                ['sh', '-c', script, 'sh', ...pairs.map(pair => pair.shell.pty)], null,
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.LEAVE_DESCRIPTORS_OPEN, null);
            const grids = Logic.parseGrids(decoder.decode(out));
            for (const {window, shell} of pairs) {
                if (grids.has(shell.pty))
                    found.set(window.window, {...grids.get(shell.pty), cwd: shell.cwd});
            }
        }
    } catch (e) {
        log(`no terminal grids: ${e.message}`);
    }
    return found;
}

function zoomTerminal(window, steps) {
    const action = new GLib.Variant('(sava{sv})', [steps > 0 ? 'zoom-in' : 'zoom-out', [], {}]);
    for (let i = 0; i < Math.abs(steps); i++) {
        Gio.DBus.session.call(window.get_gtk_unique_bus_name(), window.get_gtk_window_object_path(),
            'org.gtk.Actions', 'Activate', action, null, Gio.DBusCallFlags.NONE, -1, null, null);
    }
}

class RestoreJob {
    constructor(extension, snapshot, onDone) {
        this._ext = extension;
        this._onDone = onDone;
        this._groups = [...Logic.groupByApp(snapshot.windows)].map(([key, entries]) => ({
            key, entries, unplaced: [...entries], seen: 0, changedAt: 0, askedForMore: false,
        }));
        this._targets = [];
        this._claimed = new Set();
        this._startedAt = Date.now();
        this._timer = 0;
        this._zoomRounds = 0;
    }

    start() {
        Main.wm._workspaceTracker?.blockUpdates();
        for (const group of this._groups)
            this._launchMissing(group);
        this._tick();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESTORE_TICK_MS, () => {
            this._tick();
            return this._timer ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
    }

    cancel() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = 0;
        Main.wm._workspaceTracker?.unblockUpdates();
    }

    _liveWindows(group) {
        return savableWindows().filter(w => windowGroupKey(w) === group.key);
    }

    _launchMissing(group) {
        const live = this._liveWindows(group);
        group.seen = live.length;
        const first = group.entries[0];
        try {
            if (live.length === 0 && Logic.isBrowser(first.appId, first.wmClass) && first.appId)
                this._launchBrowser(first);
            else
                this._openWindows(group, group.entries.length - live.length);
        } catch (e) {
            log(`could not launch ${group.key}: ${e.message}`);
        }
        if (live.length < group.entries.length)
            group.changedAt = Date.now();
    }

    _launchBrowser(entry) {
        const info = Gio.DesktopAppInfo.new(entry.appId);
        if (!info)
            return;
        const command = Logic.restoringCommandline(info.get_commandline());
        Gio.AppInfo.create_from_commandline(command, info.get_name(), Gio.AppInfoCreateFlags.NONE)
            .launch([], global.create_app_launch_context(0, -1));
    }

    // The directory can only be given when the terminal opens.
    _launchTerminal(entry) {
        const dir = entry.terminal.cwd;
        const start = GLib.file_test(dir, GLib.FileTest.IS_DIR) ? dir : GLib.get_home_dir();
        // The command line follows Exec rules, where a literal % has to be doubled.
        const quoted = GLib.shell_quote(start).replaceAll('%', '%%');
        Gio.AppInfo.create_from_commandline(`gnome-terminal --window --working-directory=${quoted}`,
            'Terminal', Gio.AppInfoCreateFlags.NONE).launch([], global.create_app_launch_context(0, -1));
    }

    _openWindows(group, count) {
        const first = group.entries[0];
        if (Logic.isTerminal(first.wmClass) && first.terminal?.cwd) {
            const dirs = [...terminalGrids(this._liveWindows(group)).values()].map(t => t.cwd);
            for (const entry of Logic.entriesToOpen(group.unplaced, dirs, count)) {
                try {
                    this._launchTerminal(entry);
                } catch (e) {
                    log(`could not open a terminal: ${e.message}`);
                }
            }
            return;
        }
        const app = first.appId && Shell.AppSystem.get_default().lookup_app(first.appId);
        for (let i = 0; i < count; i++) {
            if (app)
                app.open_new_window(-1);
            else if (group.entries[i]?.commandline?.length)
                Gio.Subprocess.new(group.entries[i].commandline, Gio.SubprocessFlags.NONE);
        }
    }

    _assign(group, now) {
        if (group.unplaced.length === 0)
            return;
        const live = this._liveWindows(group);
        if (live.length !== group.seen) {
            group.seen = live.length;
            group.changedAt = now;
        }
        if (now - group.changedAt < SETTLE_MS || live.length === 0)
            return;

        const free = live.filter(w => !this._claimed.has(w));
        const first = group.entries[0];
        if (free.length < group.unplaced.length && !group.askedForMore &&
            !Logic.isBrowser(first.appId, first.wmClass)) {
            // Single-instance apps only produce the first window from a launch.
            group.askedForMore = true;
            group.changedAt = now;
            this._openWindows(group, group.unplaced.length - free.length);
            return;
        }

        const terminals = Logic.isTerminal(first.wmClass) ? terminalGrids(savableWindows()) : new Map();
        const described = free.map(window => ({
            window, title: window.get_title(), cwd: terminals.get(window)?.cwd,
        }));
        for (const {entry, window: {window}} of Logic.assignWindows(group.unplaced, described)) {
            group.unplaced.splice(group.unplaced.indexOf(entry), 1);
            this._claimed.add(window);
            this._targets.push({entry, window, tries: 0, stable: 0, done: false});
        }
    }

    _place({entry, window}, placement) {
        if (window.is_fullscreen() && !entry.fullscreen)
            window.unmake_fullscreen();
        if (window.get_maximized())
            window.unmaximize(Meta.MaximizeFlags.BOTH);
        if (window.minimized && !entry.minimized)
            window.unminimize();

        if (entry.onAllWorkspaces) {
            window.stick();
        } else {
            const manager = global.workspace_manager;
            while (manager.n_workspaces <= entry.workspace)
                manager.append_new_workspace(false, global.get_current_time());
            window.unstick();
            window.change_workspace_by_index(entry.workspace, false);
        }

        if (window.get_monitor() !== placement.monitorIndex)
            window.move_to_monitor(placement.monitorIndex);
        window.move_resize_frame(true, placement.x, placement.y, placement.width, placement.height);

        let flags = 0;
        if (entry.maximized.horizontal)
            flags |= Meta.MaximizeFlags.HORIZONTAL;
        if (entry.maximized.vertical)
            flags |= Meta.MaximizeFlags.VERTICAL;
        if (flags)
            window.maximize(flags);
        if (entry.fullscreen)
            window.make_fullscreen();
        if (entry.minimized)
            window.minimize();
    }

    _settle(target, monitors) {
        const {entry, window} = target;
        if (!window.get_compositor_private()) // closed, or not mapped yet
            return;
        const placement = Logic.resolvePlacement(entry, monitors);
        const frame = window.get_frame_rect();
        const actual = {
            monitorIndex: window.get_monitor(), x: frame.x, y: frame.y,
            width: frame.width, height: frame.height,
            fullscreen: window.is_fullscreen(), maximized: maximizedFlags(window),
        };
        const workspaceRight = entry.onAllWorkspaces ||
            window.get_workspace()?.index() === entry.workspace;

        if (target.tries > 0 && workspaceRight && Logic.placementMatches(entry, placement, actual)) {
            target.done = ++target.stable >= PLACE_STABLE_TICKS;
            return;
        }
        target.stable = 0;
        if (target.tries >= PLACE_MAX_TRIES) {
            // Size-stepped apps never match exactly; this is as close as it gets.
            target.done = true;
            target.gaveUp = `${frame.width}x${frame.height}+${frame.x}+${frame.y}`;
            return;
        }
        target.tries++;
        this._place(target, placement);
    }

    // Runs once every window is in place, as the frame has to match the saved one for its cell size
    // to compare. Zooming resizes the window, so a zoomed terminal goes back through placing.
    _zoomTerminals() {
        const targets = this._targets.filter(t => t.entry.terminal && !t.entry.minimized);
        if (!targets.length || this._zoomRounds >= ZOOM_MAX_ROUNDS)
            return false;
        this._zoomRounds++;
        const grids = terminalGrids(savableWindows());
        let zoomed = false;
        for (const target of targets) {
            const live = grids.get(target.window);
            const steps = live ? Logic.zoomSteps(target.entry.terminal, target.entry.rect, live,
                target.window.get_frame_rect()) : 0;
            if (steps === 0)
                continue;
            zoomTerminal(target.window, steps);
            Object.assign(target, {tries: 0, stable: 0, done: false, gaveUp: null});
            zoomed = true;
        }
        return zoomed;
    }

    _tick() {
        const now = Date.now();
        const monitors = this._ext.monitors();
        for (const group of this._groups)
            this._assign(group, now);
        this._targets = this._targets.filter(t => t.window.get_compositor_private());
        for (const target of this._targets.filter(t => !t.done))
            this._settle(target, monitors);

        const waiting = this._groups.some(g => g.unplaced.length > 0);
        const placing = this._targets.some(t => !t.done);
        const overdue = now - this._startedAt > RESTORE_DEADLINE_MS;
        if (overdue || (!waiting && !placing && !this._zoomTerminals()))
            this._finish();
    }

    _finish() {
        this.cancel();
        const byDepth = [...this._targets].sort((a, b) => a.entry.stack - b.entry.stack);
        for (const {window} of byDepth)
            window.raise();
        const top = byDepth.filter(t => !t.entry.minimized).at(-1);
        top?.window.focus(global.get_current_time());

        const missing = this._groups.flatMap(g => g.unplaced.map(e => e.title || e.wmClass));
        const gaveUp = byDepth.filter(t => t.gaveUp);
        log(`restore done: ${byDepth.length - gaveUp.length} placed, ${gaveUp.length} gave up, ` +
            `${missing.length} not found`);
        for (const {entry, gaveUp: got} of gaveUp) {
            const {x, y, width, height} = entry.rect;
            log(`gave up on ${entry.title}: wanted ${width}x${height}+${x}+${y}, got ${got}`);
        }
        this._onDone(missing);
    }
}

export default class SaveWinPlacement extends Extension {
    enable() {
        this._stateDir = GLib.build_filenamev([GLib.get_user_state_dir(), 'savewinplacement']);
        GLib.mkdir_with_parents(this._stateDir, 0o700);
        this._config = {autoRestore: true, ...this._read('config')};
        this._saved = this._read('session');
        this._shrinkSince = null;
        this._job = null;
        this._identities = [];
        this._autosaveTimer = 0;

        this._dbus = Gio.DBusExportedObject.wrapJSObject(DBUS_XML, this);
        this._dbus.export(Gio.DBus.session, DBUS_PATH);

        this._createIndicator();
        this._lockId = Main.sessionMode.connect('updated', () => this._syncLocked());
        this._monitorsId = Main.layoutManager.connect('monitors-changed',
            () => this._refreshIdentities());

        this._refreshIdentities(() => {
            if (!this._dbus) // disabled while waiting
                return;
            if (Main.layoutManager._startingUp) {
                this._startupId = Main.layoutManager.connect('startup-complete', () => {
                    Main.layoutManager.disconnect(this._startupId);
                    this._startupId = 0;
                    this._onLoginReady();
                });
            } else {
                this._onLoginReady();
            }
        });
    }

    disable() {
        if (this._startupId)
            Main.layoutManager.disconnect(this._startupId);
        this._startupId = 0;
        Main.layoutManager.disconnect(this._monitorsId);
        Main.sessionMode.disconnect(this._lockId);
        if (this._autosaveTimer)
            GLib.source_remove(this._autosaveTimer);
        this._autosaveTimer = 0;
        this._job?.cancel();
        this._job = null;
        this._dbus.unexport();
        this._dbus = null;
        this._indicator.destroy();
        this._indicator = null;
    }

    // --- D-Bus -----------------------------------------------------------------------------------

    Save(slot) {
        const snapshot = this._capture();
        this._write(slot || 'manual', snapshot);
        return snapshot.windows.length;
    }

    Restore(slot) {
        return this._restore(slot || 'previous-session');
    }

    List() {
        return JSON.stringify({restoring: this._job !== null, ...this._capture()});
    }

    // --- Login -----------------------------------------------------------------------------------

    _onLoginReady() {
        const firstEnable = !loginHandled;
        loginHandled = true;
        if (!firstEnable) {
            this._startAutosave();
            return;
        }
        // Autosave rewrites session.json from now on; this keeps the desktop as it was left.
        if (this._saved?.windows.length)
            this._write('previous-session', this._saved);
        if (!this._config.autoRestore || !this._restore('previous-session'))
            this._startAutosave();
    }

    // --- Saving ----------------------------------------------------------------------------------

    _capture() {
        const monitors = this.monitors();
        const open = savableWindows();
        const grids = terminalGrids(open);
        const windows = open.map((window, stack) => {
            const monitor = monitors[window.get_monitor()] ?? monitors[0];
            const rect = window.get_frame_rect();
            const appId = realAppId(window);
            return {
                appId,
                wmClass: window.get_wm_class(),
                title: window.get_title(),
                commandline: appId ? [] : readCommandline(window.get_pid()),
                monitor: {identity: monitor.identity, connector: monitor.connector},
                rect: {x: rect.x, y: rect.y, width: rect.width, height: rect.height},
                relative: {x: rect.x - monitor.x, y: rect.y - monitor.y},
                workspace: window.get_workspace()?.index() ?? 0,
                onAllWorkspaces: window.is_on_all_workspaces(),
                maximized: maximizedFlags(window),
                fullscreen: window.is_fullscreen(),
                minimized: window.minimized,
                ...(grids.has(window) ? {terminal: grids.get(window)} : {}),
                stack,
            };
        });
        return {
            monitors: monitors.map(({identity, connector, x, y, width, height}) =>
                ({identity, connector, x, y, width, height})),
            windows,
        };
    }

    _startAutosave() {
        if (this._autosaveTimer)
            return;
        this._autosaveTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, AUTOSAVE_SECONDS, () => {
            this._autosave();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _autosave() {
        if (this._job || Main.sessionMode.isLocked)
            return;
        const snapshot = this._capture();
        const decision = Logic.autosaveDecision(this._saved, snapshot, this._shrinkSince, Date.now());
        this._shrinkSince = decision.shrinkSince;
        if (decision.commit) {
            this._write('session', snapshot);
            this._saved = snapshot;
        }
    }

    // --- Restoring -------------------------------------------------------------------------------

    _restore(slot) {
        const snapshot = this._read(slot);
        if (this._job || !snapshot?.windows.length)
            return false;
        this._job = new RestoreJob(this, snapshot, missing => {
            this._job = null;
            this._startAutosave();
            if (missing.length)
                Main.notify('Some windows did not come back', missing.join(', '));
        });
        this._job.start();
        return true;
    }

    // --- Monitors --------------------------------------------------------------------------------

    monitors() {
        return Main.layoutManager.monitors.map(m => {
            const known = this._identities.find(i => i.x === m.x && i.y === m.y);
            return {
                index: m.index, x: m.x, y: m.y, width: m.width, height: m.height,
                primary: m.index === Main.layoutManager.primaryIndex,
                identity: known?.identity ?? null,
                connector: known?.connector ?? null,
            };
        });
    }

    // Shell exposes no monitor names, so they come from Mutter. Must stay async: this runs on the
    // main loop that answers the call, and a sync call to ourselves would hang the desktop.
    _refreshIdentities(done) {
        Gio.DBus.session.call('org.gnome.Mutter.DisplayConfig', '/org/gnome/Mutter/DisplayConfig',
            'org.gnome.Mutter.DisplayConfig', 'GetCurrentState', null, null,
            Gio.DBusCallFlags.NONE, -1, null, (connection, result) => {
                try {
                    const [, physical, logical] = connection.call_finish(result).recursiveUnpack();
                    const names = new Map(physical.map(([[connector, vendor, product, serial]]) =>
                        [connector, `${vendor}:${product}:${serial}`]));
                    this._identities = logical.map(([x, y, , , , members]) => ({
                        x, y, connector: members[0][0], identity: names.get(members[0][0]),
                    }));
                } catch (e) {
                    log(`no monitor names: ${e.message}`);
                }
                done?.();
            });
    }

    // --- Storage ---------------------------------------------------------------------------------

    _path(slot) {
        if (!/^[\w-]+$/.test(slot))
            throw new Error(`bad slot name: ${slot}`);
        return GLib.build_filenamev([this._stateDir, `${slot}.json`]);
    }

    _read(slot) {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._path(slot));
            return ok ? JSON.parse(decoder.decode(bytes)) : null;
        } catch {
            return null;
        }
    }

    _write(slot, data) {
        GLib.file_set_contents(this._path(slot), JSON.stringify(data, null, 1));
    }

    // --- Panel menu ------------------------------------------------------------------------------

    _createIndicator() {
        this._indicator = new PanelMenu.Button(0.5, this.metadata.name);
        this._indicator.add_child(new St.Icon({
            icon_name: 'view-restore-symbolic', style_class: 'system-status-icon',
        }));
        const menu = this._indicator.menu;
        menu.addAction('Restore last session', () => this._restore('previous-session'));
        menu.addAction('Restore saved layout', () => this._restore('manual'));
        menu.addAction('Save layout now', () => this.Save('manual'));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const auto = new PopupMenu.PopupSwitchMenuItem('Restore at login', this._config.autoRestore);
        auto.connect('toggled', (item, state) => {
            this._config.autoRestore = state;
            this._write('config', this._config);
        });
        menu.addMenuItem(auto);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._syncLocked();
    }

    // Staying enabled while locked keeps a restore running, but the menu must not be usable there.
    _syncLocked() {
        this._indicator.visible = !Main.sessionMode.isLocked;
    }
}
