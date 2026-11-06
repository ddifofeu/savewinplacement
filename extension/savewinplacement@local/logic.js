// Pure decision logic: no GNOME imports, so it runs under plain gjs in tests/logic.test.js.

// How long a lower window count must persist before autosave accepts it. Windows close one by one
// during a shutdown; without this the last snapshot would be a half-empty desktop.
export const SHRINK_GRACE_MS = 45000;

// Tried in order when a monitor is looked up, so a screen moved to another port still matches.
const monitorKeys = m => [m.identity, m.connector].filter(Boolean);

const BROWSER_RE = /brave|chrom(e|ium)|vivaldi|msedge|microsoft-edge|opera/i;

export function isBrowser(appId, wmClass) {
    return BROWSER_RE.test(appId ?? '') || BROWSER_RE.test(wmClass ?? '');
}

// Browsers ignore window count on launch: they reopen their own windows, but only when asked to.
export function restoringCommandline(commandline) {
    const cleaned = commandline.replace(/\s%[a-zA-Z]/g, '').trim();
    return `${cleaned} --restore-last-session`;
}

// What ties a window to an application across sessions. Shell invents a "window:N" id for windows
// with no .desktop file; that id means nothing after a reboot, so those group by class instead.
export function groupKey(appId, wmClass) {
    return appId && !appId.startsWith('window:') ? appId : `class:${wmClass ?? 'unknown'}`;
}

export function groupByApp(entries) {
    const groups = new Map();
    for (const entry of entries) {
        const key = groupKey(entry.appId, entry.wmClass);
        if (!groups.has(key))
            groups.set(key, []);
        groups.get(key).push(entry);
    }
    return groups;
}

// Pairs saved entries with live windows of one app: same terminal directory first, as new terminals
// all share a title; then exact title, then a shared title start (titles gain counters and
// suffixes), then whatever remains in saved order. Each is used once.
export function assignWindows(entries, windows) {
    const pairs = [];
    const entriesLeft = [...entries];
    const windowsLeft = [...windows];
    const take = matches => {
        for (const entry of [...entriesLeft]) {
            const window = windowsLeft.find(w => matches(entry.title ?? '', w.title ?? '', entry, w));
            if (!window)
                continue;
            pairs.push({entry, window});
            entriesLeft.splice(entriesLeft.indexOf(entry), 1);
            windowsLeft.splice(windowsLeft.indexOf(window), 1);
        }
    };
    const stem = title => title.replace(/^\(\d+\)\s*/, '').slice(0, 24).toLowerCase();
    take((_a, _b, entry, w) => entry.terminal?.cwd && entry.terminal.cwd === w.cwd);
    take((a, b) => a !== '' && a === b);
    take((a, b) => stem(a) !== '' && stem(a) === stem(b));
    take(() => true);
    return pairs;
}

// Terminals still to open, at most `count`: entries whose directory no live terminal already covers.
export function entriesToOpen(entries, liveDirs, count) {
    const left = [...liveDirs];
    return entries.filter(entry => {
        const found = left.indexOf(entry.terminal?.cwd);
        if (found < 0)
            return true;
        left.splice(found, 1);
        return false;
    }).slice(0, Math.max(0, count));
}

export function isTerminal(wmClass) {
    return wmClass === 'gnome-terminal-server';
}

// `stty size` answers "rows cols"; the shell loop reading it prefixes each line with the pty.
export function parseGrids(output) {
    const grids = new Map();
    for (const line of output.split('\n')) {
        const [pty, rows, cols] = line.trim().split(/\s+/);
        if (rows > 0 && cols > 0)
            grids.set(pty, {cols: Number(cols), rows: Number(rows)});
    }
    return grids;
}

// Pairs terminal windows with their shells, as nothing in gnome-terminal links the two. Window
// paths count up (/org/gnome/Terminal/window/N) and so do shell pids, both in creation order. With
// tabs there are more shells than windows and no way to tell whose they are, so nothing is paired.
export function pairTerminals(windows, shells) {
    if (windows.length !== shells.length)
        return [];
    const number = w => Number(w.path.match(/(\d+)$/)?.[1] ?? 0);
    const byPath = [...windows].sort((a, b) => number(a) - number(b));
    const byPid = [...shells].sort((a, b) => a.pid - b.pid);
    return byPath.map((window, i) => ({window, shell: byPid[i]}));
}

// One press of zoom in or out in GNOME Terminal scales the font by this.
const ZOOM_STEP = 1.2;

// Presses of zoom in (negative: zoom out) that bring a terminal back to its saved font size.
// Terminals expose no zoom level, but cell size follows it: the frame divided by the grid. Taking
// the frame whole counts the title bar too, which cancels out as the two frames are about the same.
export function zoomSteps(saved, savedFrame, live, liveFrame) {
    const ratio = dimension => [saved, live]
        .map((grid, i) => [savedFrame, liveFrame][i][dimension] /
            grid[dimension === 'width' ? 'cols' : 'rows'])
        .reduce((a, b) => a / b);
    const scale = Math.sqrt(ratio('width') * ratio('height'));
    return Math.round(Math.log(scale) / Math.log(ZOOM_STEP));
}

export function findMonitor(saved, monitors) {
    const wanted = monitorKeys(saved);
    for (const key of wanted) {
        const match = monitors.find(m => monitorKeys(m).includes(key));
        if (match)
            return match;
    }
    return null;
}

// Where a saved window goes on today's monitors. Saved positions are relative to their monitor so a
// changed layout keeps them on the right screen; a missing monitor falls back to the primary one.
export function resolvePlacement(entry, monitors) {
    const monitor = findMonitor(entry.monitor ?? {}, monitors) ??
        monitors.find(m => m.primary) ?? monitors[0];
    const width = Math.min(entry.rect.width, monitor.width);
    const height = Math.min(entry.rect.height, monitor.height);
    const clamp = (value, max) => Math.max(0, Math.min(value, max));
    return {
        monitorIndex: monitor.index,
        x: monitor.x + clamp(entry.relative.x, monitor.width - width),
        y: monitor.y + clamp(entry.relative.y, monitor.height - height),
        width,
        height,
    };
}

export function fingerprint(snapshot) {
    return JSON.stringify([snapshot.monitors, snapshot.windows]);
}

// Decides whether a captured snapshot replaces the saved one. `saved` is the last committed
// snapshot, `shrinkSince` the time a lower window count was first seen (null if none).
export function autosaveDecision(saved, current, shrinkSince, now) {
    if (!saved)
        return {commit: true, shrinkSince: null};
    // A monitor asleep or unplugged pushes windows onto the others. That is not the layout to keep;
    // a deliberate change of monitors is committed by an explicit save.
    if (current.monitors.length < saved.monitors.length)
        return {commit: false, shrinkSince: null};
    if (current.windows.length < saved.windows.length) {
        const since = shrinkSince ?? now;
        return now - since >= SHRINK_GRACE_MS
            ? {commit: true, shrinkSince: null}
            : {commit: false, shrinkSince: since};
    }
    return {commit: fingerprint(saved) !== fingerprint(current), shrinkSince: null};
}

// A placement is right when the window is where the snapshot says. Maximized and fullscreen windows
// are sized by the shell, so only their monitor counts; apps that size in steps (terminals) get
// tolerance through the retry limit, not here.
export function placementMatches(entry, target, actual) {
    if (actual.monitorIndex !== target.monitorIndex)
        return false;
    if (entry.fullscreen)
        return actual.fullscreen;
    if (entry.maximized.horizontal && entry.maximized.vertical)
        return actual.maximized.horizontal && actual.maximized.vertical;
    const near = (a, b) => Math.abs(a - b) <= 2;
    return near(actual.x, target.x) && near(actual.y, target.y) &&
        near(actual.width, target.width) && near(actual.height, target.height);
}
