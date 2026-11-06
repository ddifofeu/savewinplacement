// Run with: gjs -m tests/logic.test.js
import * as Logic from '../extension/savewinplacement@local/logic.js';

let failures = 0;
function check(name, actual, expected) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e)
        return;
    failures++;
    print(`FAIL ${name}\n  got      ${a}\n  expected ${e}`);
}

const titles = pairs => pairs.map(p => `${p.entry.title}->${p.window.title}`);
const snap = (windows, monitors = 2) => ({
    monitors: Array(monitors).fill({connector: 'x'}),
    windows: Array(windows).fill({a: 1}),
});

// Browser windows must land on their own monitor even when they appear in a different order.
check('exact titles beat arrival order',
    titles(Logic.assignWindows([{title: 'Mail'}, {title: 'Docs'}], [{title: 'Docs'}, {title: 'Mail'}])),
    ['Mail->Mail', 'Docs->Docs']);
check('unread counter in a title still matches',
    titles(Logic.assignWindows([{title: '(3) Inbox - Brave'}, {title: 'Docs'}],
        [{title: 'Docs'}, {title: 'Inbox - Brave'}])),
    ['Docs->Docs', '(3) Inbox - Brave->Inbox - Brave']);
check('unknown titles fall back to order',
    titles(Logic.assignWindows([{title: 'a'}, {title: 'b'}], [{title: 'x'}, {title: 'y'}])),
    ['a->x', 'b->y']);
check('a window is never used twice',
    Logic.assignWindows([{title: 'a'}, {title: 'a'}], [{title: 'a'}]).length, 1);
check('extra live windows are left alone',
    Logic.assignWindows([{title: 'a'}], [{title: 'b'}, {title: 'a'}]).map(p => p.window.title), ['a']);

const dell = {index: 0, identity: 'AAA:Screen:1', connector: 'DP-1', x: 0, y: 0, width: 3840, height: 2160, primary: true};
const lg = {index: 1, identity: 'BBB:Screen:2', connector: 'HDMI-1', x: 3840, y: 0, width: 1720, height: 1440, primary: false};
const onLg = {
    monitor: {identity: 'BBB:Screen:2', connector: 'HDMI-1'},
    rect: {x: 3940, y: 50, width: 800, height: 600},
    relative: {x: 100, y: 50},
};

check('second monitor keeps absolute position', Logic.resolvePlacement(onLg, [dell, lg]),
    {monitorIndex: 1, x: 3940, y: 50, width: 800, height: 600});
check('monitor swapped to another port is found by identity',
    Logic.resolvePlacement(onLg, [{...lg, index: 0, connector: 'DP-2', x: 0}, {...dell, index: 1, connector: 'HDMI-1', x: 1720}]),
    {monitorIndex: 0, x: 100, y: 50, width: 800, height: 600});
check('missing monitor falls back to primary', Logic.resolvePlacement(onLg, [dell]),
    {monitorIndex: 0, x: 100, y: 50, width: 800, height: 600});
check('window stays on a smaller screen',
    Logic.resolvePlacement({...onLg, rect: {...onLg.rect, width: 3000, height: 2000}, relative: {x: 900, y: 900}}, [lg]),
    {monitorIndex: 1, x: 3840, y: 0, width: 1720, height: 1440});

const T0 = 1000000;
const grace = Logic.SHRINK_GRACE_MS;
check('first snapshot commits', Logic.autosaveDecision(null, snap(3), null, T0).commit, true);
check('unchanged snapshot does not write', Logic.autosaveDecision(snap(3), snap(3), null, T0).commit, false);
check('new window commits', Logic.autosaveDecision(snap(3), snap(4), null, T0).commit, true);
check('windows closing at shutdown do not commit',
    Logic.autosaveDecision(snap(5), snap(2), null, T0), {commit: false, shrinkSince: T0});
check('still inside the grace period',
    Logic.autosaveDecision(snap(5), snap(0), T0, T0 + grace - 1), {commit: false, shrinkSince: T0});
check('a lasting smaller desktop commits',
    Logic.autosaveDecision(snap(5), snap(4), T0, T0 + grace), {commit: true, shrinkSince: null});
check('reopened windows cancel the grace period',
    Logic.autosaveDecision(snap(5), snap(5), T0, T0 + grace).shrinkSince, null);
check('a sleeping monitor never commits',
    Logic.autosaveDecision(snap(5, 2), snap(6, 1), null, T0).commit, false);

const entry = {maximized: {horizontal: false, vertical: false}, fullscreen: false};
const target = {monitorIndex: 1, x: 3940, y: 50, width: 800, height: 600};
const actual = {...target, fullscreen: false, maximized: entry.maximized};
check('exact placement matches', Logic.placementMatches(entry, target, actual), true);
check('moved window does not match', Logic.placementMatches(entry, target, {...actual, x: 100}), false);
check('wrong monitor does not match', Logic.placementMatches(entry, target, {...actual, monitorIndex: 0}), false);
check('maximized window ignores its saved size',
    Logic.placementMatches({...entry, maximized: {horizontal: true, vertical: true}}, target,
        {...actual, width: 1720, maximized: {horizontal: true, vertical: true}}), true);

check('Brave is a browser', Logic.isBrowser('brave_brave.desktop', 'brave-browser'), true);
check('an editor is not', Logic.isBrowser('org.gnome.TextEditor.desktop', 'gnome-text-editor'), false);
check('browser restore flag replaces field codes', Logic.restoringCommandline('/snap/bin/brave %U'),
    '/snap/bin/brave --restore-last-session');
check('session-less window ids group by class', Logic.groupKey('window:12', 'MyTool'), 'class:MyTool');
check('real ids group by id', Logic.groupKey('foo.desktop', 'Foo'), 'foo.desktop');

check('terminals pair by directory, as their titles say nothing',
    Logic.assignWindows(
        [{title: 'x', terminal: {cwd: '/a'}}, {title: 'x', terminal: {cwd: '/b'}}],
        [{title: 'x', cwd: '/b'}, {title: 'x', cwd: '/a'}]).map(p => p.window.cwd), ['/a', '/b']);
const inDirs = (...dirs) => dirs.map(cwd => ({terminal: {cwd}}));
check('only terminals not open yet get launched',
    Logic.entriesToOpen(inDirs('/a', '/b', '/b'), ['/b'], 2).map(e => e.terminal.cwd), ['/a', '/b']);
check('more terminals open than saved launches nothing',
    Logic.entriesToOpen(inDirs('/a', '/b', '/c'), [], -2), []);

const frame = {width: 854, height: 705};
check('same grid needs no zoom', Logic.zoomSteps({cols: 106, rows: 36}, frame, {cols: 106, rows: 36}, frame), 0);
check('one step smaller font', Logic.zoomSteps({cols: 120, rows: 41}, frame, {cols: 106, rows: 36}, frame), -1);
check('two steps smaller font', Logic.zoomSteps({cols: 141, rows: 51}, frame, {cols: 106, rows: 36}, frame), -2);
check('larger font zooms in', Logic.zoomSteps({cols: 106, rows: 36}, frame, {cols: 141, rows: 51}, frame), 2);
check('a frame a few pixels off changes nothing',
    Logic.zoomSteps({cols: 106, rows: 36}, frame, {cols: 106, rows: 36}, {width: 860, height: 712}), 0);
check('stty output parses, and a dead pty is skipped',
    [...Logic.parseGrids('/dev/pts/0 51 141\n/dev/pts/1 \n')], [['/dev/pts/0', {cols: 141, rows: 51}]]);
const paths = ['/org/gnome/Terminal/window/10', '/org/gnome/Terminal/window/9'].map(path => ({path}));
check('windows pair with shells in creation order',
    Logic.pairTerminals(paths, [{pid: 700}, {pid: 90}]).map(p => [p.window.path.slice(-2), p.shell.pid]),
    [['/9', 90], ['10', 700]]);
check('tabs leave terminals unpaired', Logic.pairTerminals(paths, [{pid: 1}, {pid: 2}, {pid: 3}]), []);

print(failures ? `${failures} failed` : 'logic tests passed');
if (failures)
    imports.system.exit(1);
