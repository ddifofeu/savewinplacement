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

// Pairs saved entries with live windows of one app: exact title first, then a shared title start
// (titles gain counters and suffixes), then whatever remains in saved order. Each is used once.
export function assignWindows(entries, windows) {
    const pairs = [];
    const entriesLeft = [...entries];
    const windowsLeft = [...windows];
    const take = matches => {
        for (const entry of [...entriesLeft]) {
            const window = windowsLeft.find(w => matches(entry.title ?? '', w.title ?? ''));
            if (!window)
                continue;
            pairs.push({entry, window});
            entriesLeft.splice(entriesLeft.indexOf(entry), 1);
            windowsLeft.splice(windowsLeft.indexOf(window), 1);
        }
    };
    const stem = title => title.replace(/^\(\d+\)\s*/, '').slice(0, 24).toLowerCase();
    take((a, b) => a !== '' && a === b);
    take((a, b) => stem(a) !== '' && stem(a) === stem(b));
    take(() => true);
    return pairs;
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
