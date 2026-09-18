const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../out/peekAppearance.js'), 'utf8');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const kinds = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };

function event() {
    const listeners = new Set();
    return {
        subscribe: callback => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
        fire: value => { for (const callback of listeners) callback(value); },
        listeners
    };
}

function setup(t, initial) {
    const configEvent = event(), themeEvent = event(), foldersEvent = event();
    const h = {
        config: { enabled: true, peekStyle: 'theme', peekColors: {} },
        colors: clone(initial), theme: 'Dark Test', kind: kinds.Dark,
        state: {}, writes: [], logs: [], errors: [], configEvent, themeEvent, foldersEvent,
        beforeWrite: async () => {}, afterWrite: async () => {}, afterState: async () => {}
    };
    const state = {
        get: (key, fallback) => clone(h.state[key] ?? fallback),
        update: async (key, value) => {
            if (value === undefined) delete h.state[key]; else h.state[key] = clone(value);
            await h.afterState();
        }
    };
    const vscode = {
        ColorThemeKind: kinds, ConfigurationTarget: { Workspace: 2 },
        workspace: {
            workspaceFolders: [{}],
            onDidChangeConfiguration: configEvent.subscribe,
            onDidChangeWorkspaceFolders: foldersEvent.subscribe,
            getConfiguration: section => section === 'pythonReferenceLens'
                ? { get: (key, fallback) => h.config[key] ?? fallback }
                : {
                    get: key => key === 'colorTheme' ? h.theme : h.colors,
                    inspect: key => { assert.equal(key, 'colorCustomizations'); return { workspaceValue: clone(h.colors) }; },
                    update: async (key, value, target) => {
                        assert.equal(key, 'colorCustomizations');
                        assert.equal(target, 2);
                        await h.beforeWrite();
                        h.colors = clone(value);
                        h.writes.push(clone(value));
                        configEvent.fire({ affectsConfiguration: key => key === 'workbench.colorCustomizations' });
                        await h.afterWrite();
                    }
                }
        },
        window: {
            get activeColorTheme() { return { kind: h.kind }; },
            onDidChangeActiveColorTheme: themeEvent.subscribe,
            showErrorMessage: async message => h.errors.push(message)
        }
    };
    const exports = {};
    vm.runInNewContext(source, { exports, require: () => vscode });
    h.exports = exports;
    h.vscode = vscode;
    h.create = () => new exports.PeekAppearance(state, { appendLine: line => h.logs.push(line) });
    h.controller = h.create();
    h.choose = async style => {
        h.config.peekStyle = style;
        configEvent.fire({ affectsConfiguration: key => key === 'pythonReferenceLens.peekStyle' });
        await h.controller.sync();
    };
    h.block = () => h.colors?.[`[${h.theme}]`];
    t.after(() => h.controller.dispose());
    return h;
}

test('default theme never writes settings or backup state', async t => {
    const h = setup(t, { 'editor.background': '#123456' });
    await h.controller.sync();
    assert.equal(h.writes.length, 0);
    assert.deepEqual(h.state, {});
});

test('contrast is theme-scoped and restores existing colors without copying inherited settings', async t => {
    const original = {
        'editor.background': '#123456', 'peekView.border': '#112233',
        '[Other Theme]': { 'peekView.border': '#998877' },
        '[Dark Test]': { 'peekView.border': '#ABCDEF', 'editor.foreground': '#DDDDDD' }
    };
    const h = setup(t, original);
    await h.choose('contrast');
    assert.notEqual(h.block()['peekView.border'], '#ABCDEF');
    assert.notEqual(h.block()['peekViewEditor.background'], h.block()['peekViewResult.background']);
    assert.equal(h.colors['editor.background'], '#123456');
    assert.equal(h.colors['peekView.border'], '#112233');
    assert.deepEqual(h.colors['[Other Theme]'], original['[Other Theme]']);
    assert.equal(h.block()['editor.foreground'], '#DDDDDD');
    await h.choose('theme');
    assert.deepEqual(h.colors, original);
    assert.deepEqual(h.state, {});
});

test('restores an absent setting and preserves a previously empty setting/block', async t => {
    for (const original of [undefined, {}, { '[Dark Test]': {} }]) {
        const h = setup(t, original);
        await h.choose('contrast');
        await h.choose('theme');
        assert.deepEqual(h.colors, original);
    }
});

test('switching to accented releases backgrounds and repeated sync makes no settings writes', async t => {
    const h = setup(t);
    await h.choose('contrast');
    await h.choose('accented');
    assert.equal(h.block()['peekViewEditor.background'], undefined);
    assert.equal(h.block()['peekViewResult.background'], undefined);
    assert.ok(h.block()['peekView.border']);
    assert.ok(h.block()['peekViewTitle.background']);
    const writes = h.writes.length;
    await h.controller.sync();
    assert.equal(h.writes.length, writes);
    await h.choose('theme');
    assert.equal(h.colors, undefined);
});

test('custom overrides apply only in custom mode and invalid values are ignored', async t => {
    const h = setup(t);
    h.config.peekColors = { border: '#12AB34', editorBackground: 'not-a-color', matchBackground: '#ABC3', arbitrary: '#123456' };
    await h.choose('contrast');
    assert.notEqual(h.block()['peekView.border'], '#12AB34');
    const background = h.block()['peekViewEditor.background'];
    await h.choose('custom');
    assert.equal(h.block()['peekView.border'], '#12AB34');
    assert.equal(h.block()['peekViewEditor.matchHighlightBorder'], '#12AB34');
    assert.equal(h.block()['peekViewEditor.matchHighlightBackground'], '#ABC3');
    assert.equal(h.block()['peekViewEditor.background'], background);
    assert.equal(h.block().arbitrary, undefined);
    h.config.peekColors.border = '#FEDCBA';
    h.configEvent.fire({ affectsConfiguration: key => key === 'pythonReferenceLens.peekColors' });
    await h.controller.sync();
    assert.equal(h.block()['peekView.border'], '#FEDCBA');
});

test('theme changes release the old theme block and use a light palette', async t => {
    const original = { '[Light Test]': { 'peekView.border': '#123456' } };
    const h = setup(t, original);
    await h.choose('contrast');
    const dark = h.block()['peekViewEditor.background'];
    h.theme = 'Light Test';
    h.kind = kinds.Light;
    h.themeEvent.fire({ kind: kinds.Light });
    await h.controller.sync();
    assert.equal(h.colors['[Dark Test]'], undefined);
    assert.notEqual(h.block()['peekViewEditor.background'], dark);
    await h.choose('theme');
    assert.deepEqual(h.colors, original);
});

test('reset preserves manual edits, newly added keys and unrelated theme overrides', async t => {
    const h = setup(t);
    await h.choose('contrast');
    h.block()['peekView.border'] = '#DEAD00';
    h.block()['editor.foreground'] = '#123456';
    h.colors['editor.background'] = '#112233';
    delete h.block()['peekViewTitle.background'];
    await h.choose('theme');
    assert.deepEqual(h.colors, {
        'editor.background': '#112233',
        '[Dark Test]': { 'peekView.border': '#DEAD00', 'editor.foreground': '#123456' }
    });
});

test('a later preset change preserves a manual color as the new restoration baseline', async t => {
    const h = setup(t);
    await h.choose('contrast');
    h.block()['peekView.border'] = '#AABBCC';
    await h.choose('accented');
    await h.choose('theme');
    assert.deepEqual(h.colors, { '[Dark Test]': { 'peekView.border': '#AABBCC' } });
});

test('backup survives extension host restart and restores the original overrides', async t => {
    const original = { '[Dark Test]': { 'peekView.border': '#123456' } };
    const h = setup(t, original);
    await h.choose('contrast');
    h.controller.dispose(); // Simulate a host crash without graceful restoration.
    h.controller = h.create();
    await h.controller.sync();
    await h.choose('theme');
    assert.deepEqual(h.colors, original);
});

test('a failed settings write retains enough backup to restore the previous preset', async t => {
    const original = { '[Dark Test]': { 'peekView.border': '#123456' } };
    const h = setup(t, original);
    await h.choose('contrast');
    const active = clone(h.colors);
    h.beforeWrite = async () => { throw new Error('Settings file is read-only'); };
    h.config.peekStyle = 'accented';
    await h.controller.sync();
    assert.deepEqual(h.colors, active);
    assert.match(h.logs[0], /read-only/);
    assert.equal(h.errors.length, 1);
    h.beforeWrite = async () => {};
    await h.choose('theme');
    assert.deepEqual(h.colors, original);
});

test('an interrupted settings write after commit is recoverable on restart', async t => {
    const original = { '[Dark Test]': { 'peekView.border': '#123456' } };
    const h = setup(t, original);
    await h.choose('accented');
    h.afterWrite = async () => { throw new Error('Host stopped after settings commit'); };
    h.config.peekStyle = 'contrast';
    await h.controller.sync();
    h.controller.dispose();
    h.controller = h.create();
    h.afterWrite = async () => {};
    await h.choose('theme');
    assert.deepEqual(h.colors, original);
});

test('an external edit while persisting backup is merged instead of overwritten', async t => {
    const h = setup(t);
    let changed = false;
    h.afterState = async () => {
        if (!changed) {
            changed = true;
            h.colors = { 'editor.background': '#345678' };
        }
    };
    await h.choose('contrast');
    assert.equal(h.colors['editor.background'], '#345678');
    await h.choose('theme');
    assert.deepEqual(h.colors, { 'editor.background': '#345678' });
});

test('queued changes are serialized and the latest selected style wins', async t => {
    const h = setup(t);
    let release;
    const paused = new Promise(resolve => { release = resolve; });
    h.beforeWrite = () => paused;
    h.config.peekStyle = 'contrast';
    const first = h.controller.sync();
    await new Promise(resolve => setImmediate(resolve));
    h.config.peekStyle = 'theme';
    const second = h.controller.sync();
    release();
    await Promise.all([first, second]);
    assert.equal(h.colors, undefined);
    assert.deepEqual(h.state, {});
});

test('disabling and shutting down restore colors; closed controllers stop responding', async t => {
    const h = setup(t);
    await h.choose('contrast');
    h.config.enabled = false;
    h.configEvent.fire({ affectsConfiguration: key => key === 'pythonReferenceLens.enabled' });
    await h.controller.sync();
    assert.equal(h.colors, undefined);
    h.config.enabled = true;
    await h.controller.sync();
    assert.ok(h.block());
    await h.controller.restore();
    assert.equal(h.colors, undefined);
    assert.equal(h.configEvent.listeners.size, 0);
    assert.equal(h.themeEvent.listeners.size, 0);
    const writes = h.writes.length;
    await h.controller.sync();
    assert.equal(h.writes.length, writes);
});

test('a window without a workspace does not change global user settings', async t => {
    const h = setup(t);
    h.vscode.workspace.workspaceFolders = undefined;
    h.config.peekStyle = 'contrast';
    await h.controller.sync();
    assert.equal(h.writes.length, 0);
    assert.match(h.logs[0], /Open a folder or workspace/);
});

function luminance(hex) {
    const channels = hex.slice(1).match(/../g).map(component => {
        const value = parseInt(component, 16) / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

test('preset title, result and selected text retain at least 4.5:1 contrast for all theme kinds', t => {
    const h = setup(t);
    for (const kind of Object.values(kinds)) {
        const colors = h.exports.peekColors('contrast', kind);
        for (const [foreground, background] of [
            ['peekViewTitleLabel.foreground', 'peekViewTitle.background'],
            ['peekViewResult.fileForeground', 'peekViewResult.background'],
            ['peekViewResult.selectionForeground', 'peekViewResult.selectionBackground']
        ]) {
            const values = [luminance(colors[foreground]), luminance(colors[background])].sort((a, b) => a - b);
            assert.ok((values[1] + 0.05) / (values[0] + 0.05) >= 4.5, `${kind}: ${foreground}`);
        }
        assert.match(colors['peekViewEditor.matchHighlightBackground'], /^#[0-9A-F]{8}$/);
        assert.notEqual(colors['peekViewEditor.matchHighlightBackground'].slice(-2), 'FF');
    }
});
