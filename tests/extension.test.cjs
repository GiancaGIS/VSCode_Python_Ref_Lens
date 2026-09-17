const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../out/extension.js'), 'utf8');

class EventEmitter {
    listeners = new Set();
    event = listener => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
    };
    fire(value) {
        for (const listener of this.listeners) listener(value);
    }
    dispose() { this.listeners.clear(); }
}

class Position {
    constructor(line, character) { Object.assign(this, { line, character }); }
}

class Range {
    constructor(start, end) { Object.assign(this, { start, end }); }
}

class CodeLens {
    constructor(range) { this.range = range; }
}

function uri(name) { return { toString: () => `file:///workspace/${name}` }; }
function document(name) {
    return { uri: uri(name), languageId: 'python', version: 1, isClosed: false };
}
function location(name, line = 0) {
    return { uri: uri(name), range: new Range(new Position(line, 0), new Position(line, 5)) };
}
function symbol(name = 'greet', line = 0, kind = 11, children = []) {
    return {
        name, kind, children,
        range: new Range(new Position(line, 0), new Position(line + 5, 20)),
        selectionRange: new Range(new Position(line, 4), new Position(line, 4 + name.length))
    };
}
function token() { return { isCancellationRequested: false }; }
function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

function setup(t) {
    const events = Object.fromEntries([
        'edit', 'save', 'close', 'folders', 'config', 'create', 'diskChange', 'delete'
    ].map(name => [name, new EventEmitter()]));
    const a = document('a.py');
    const b = document('b.py');
    const timers = new Map();
    let now = 0, timerId = 0;
    const h = {
        a, b, events, logs: [], referenceCalls: 0, symbolCalls: 0, refreshes: 0,
        config: { enabled: true, showZeroReferences: true },
        symbols: async () => [symbol()],
        references: async () => [location('b.py')],
        tick(ms) {
            now += ms;
            for (const [id, timer] of [...timers]) {
                if (timer.at <= now) {
                    timers.delete(id);
                    timer.callback();
                }
            }
        },
        edit(doc = b) {
            doc.version++;
            events.edit.fire({ document: doc, contentChanges: [{ text: 'changed' }] });
        }
    };
    const subscriptions = [];
    const vscode = {
        Position, Range, CodeLens, EventEmitter,
        SymbolKind: { Function: 11, Method: 5, Class: 4 },
        window: {
            createOutputChannel: () => ({
                appendLine: line => h.logs.push(line), dispose() {}
            })
        },
        languages: {
            registerCodeLensProvider: (_selector, provider) => {
                h.provider = provider;
                return { dispose() {} };
            }
        },
        commands: {
            registerCommand: (name, callback) => {
                h.refresh = callback;
                return { dispose() {} };
            },
            executeCommand: async (name, ...args) => {
                if (name === 'vscode.executeDocumentSymbolProvider') {
                    h.symbolCalls++;
                    return h.symbols(...args);
                }
                assert.equal(name, 'vscode.executeReferenceProvider');
                h.referenceCalls++;
                return h.references(...args);
            }
        },
        workspace: {
            textDocuments: [a, b],
            getConfiguration: () => ({ get: (key, fallback) => h.config[key] ?? fallback }),
            onDidChangeTextDocument: events.edit.event,
            onDidSaveTextDocument: events.save.event,
            onDidCloseTextDocument: events.close.event,
            onDidChangeWorkspaceFolders: events.folders.event,
            onDidChangeConfiguration: events.config.event,
            createFileSystemWatcher: pattern => {
                assert.equal(pattern, '**/*.{py,pyi,pyw}');
                return {
                    onDidCreate: events.create.event,
                    onDidChange: events.diskChange.event,
                    onDidDelete: events.delete.event,
                    dispose() {}
                };
            }
        }
    };
    const exports = {};
    vm.runInNewContext(source, {
        exports,
        require: name => {
            assert.equal(name, 'vscode');
            return vscode;
        },
        setTimeout: (callback, delay) => {
            const id = ++timerId;
            timers.set(id, { callback, at: now + delay });
            return id;
        },
        clearTimeout: id => timers.delete(id)
    }, { filename: 'extension.js' });
    exports.activate({ subscriptions });
    h.provider.onDidChangeCodeLenses(() => h.refreshes++);
    h.lenses = (doc = a, cancellation = token()) => h.provider.provideCodeLenses(doc, cancellation);
    h.resolve = (lens, cancellation = token()) => h.provider.resolveCodeLens(lens, cancellation);
    h.count = async () => (await h.resolve((await h.lenses())[0])).command.title;
    h.dispose = () => subscriptions.forEach(item => item.dispose());
    t.after(h.dispose);
    return h;
}

test('discovers nested methods and places lenses on the symbol name line', async t => {
    const h = setup(t);
    h.symbols = async () => [symbol('Calculator', 0, 4, [symbol('add', 2, 5)]), symbol('main', 10)];
    const lenses = await h.lenses();
    assert.equal(lenses.length, 2);
    assert.equal(lenses[0].range.start.line, 2);
    assert.equal(lenses[0].range.start.character, 4);
    for (const lens of lenses) assert.equal(lens.range.start.line, lens.range.end.line);
});

test('supports flat symbols and ignores locations belonging to another document', async t => {
    const h = setup(t);
    h.symbols = async () => [
        { kind: 11, location: location('a.py', 3) },
        { kind: 11, location: location('b.py', 7) }
    ];
    const lenses = await h.lenses();
    assert.equal(lenses.length, 1);
    assert.equal(lenses[0].range.start.line, 3);
    assert.equal(lenses[0].range.end.line, 3);
});

test('deduplicates references, caches them and preserves the references UI command', async t => {
    const h = setup(t);
    h.references = async () => [location('b.py'), location('b.py'), location('b.py', 2)];
    const lens = await h.resolve((await h.lenses())[0]);
    assert.equal(lens.command.title, '2 references');
    assert.equal(lens.command.command, 'editor.action.showReferences');
    assert.equal(lens.command.arguments[0], h.a.uri);
    assert.equal(lens.command.arguments[2].length, 2);
    assert.equal(await h.count(), '2 references');
    assert.equal(h.referenceCalls, 1);
});

test('adding and removing callers in another document invalidates the function count', async t => {
    const h = setup(t);
    assert.equal(await h.count(), '1 reference');
    h.references = async () => [location('b.py'), location('b.py', 2)];
    h.edit(h.b);
    h.tick(400);
    assert.equal(await h.count(), '2 references');
    h.references = async () => [];
    h.edit(h.b);
    h.tick(400);
    assert.equal(await h.count(), '0 references');
    assert.equal(h.referenceCalls, 3);
});

test('coalesces rapid edits into one refresh after 400 ms of quiet', t => {
    const h = setup(t);
    h.edit();
    h.tick(200);
    h.edit();
    h.tick(399);
    assert.equal(h.refreshes, 0);
    h.tick(1);
    assert.equal(h.refreshes, 1);
    h.tick(1000);
    assert.equal(h.refreshes, 1);
});

test('ignores non-Python edits and events without content changes', t => {
    const h = setup(t);
    h.events.edit.fire({ document: h.a, contentChanges: [] });
    h.edit({ ...h.b, languageId: 'plaintext' });
    h.tick(400);
    assert.equal(h.refreshes, 0);
});

test('rejects old lenses immediately, before the debounced refresh fires', async t => {
    const h = setup(t);
    const lens = (await h.lenses())[0];
    h.edit(h.b);
    await h.resolve(lens);
    assert.equal(h.referenceCalls, 0);
    assert.equal(lens.command, undefined);
    assert.equal(h.refreshes, 0);
});

test('shares concurrent requests even when one consumer cancels', async t => {
    const h = setup(t);
    const response = deferred();
    h.references = () => response.promise;
    const first = (await h.lenses())[0];
    const second = (await h.lenses())[0];
    const cancelled = token();
    const results = [h.resolve(first, cancelled), h.resolve(second)];
    assert.equal(h.referenceCalls, 1);
    cancelled.isCancellationRequested = true;
    response.resolve([location('b.py')]);
    await Promise.all(results);
    assert.equal(first.command, undefined);
    assert.equal(second.command.title, '1 reference');
    assert.equal(await h.count(), '1 reference');
    assert.equal(h.referenceCalls, 1);
});

test('late responses cannot overwrite a newer generation of cached references', async t => {
    const h = setup(t);
    const response = deferred();
    h.references = () => response.promise;
    const oldLens = (await h.lenses())[0];
    const oldResult = h.resolve(oldLens);
    h.edit(h.b);
    h.references = async () => [location('b.py'), location('b.py', 4)];
    assert.equal(await h.count(), '2 references');
    response.resolve([location('b.py')]);
    await oldResult;
    assert.equal(oldLens.command, undefined);
    assert.equal(await h.count(), '2 references');
    assert.equal(h.referenceCalls, 2);
});

test('manual refresh discards in-flight references and cancels the scheduled refresh', async t => {
    const h = setup(t);
    h.edit();
    const response = deferred();
    h.references = () => response.promise;
    const lens = (await h.lenses())[0];
    const result = h.resolve(lens);
    h.refresh();
    assert.equal(h.refreshes, 1);
    response.resolve([location('b.py')]);
    await result;
    assert.equal(lens.command, undefined);
    h.tick(400);
    assert.equal(h.refreshes, 1);
    h.references = async () => [];
    assert.equal(await h.count(), '0 references');
});

test('discards symbol results if the document changes while discovery is pending', async t => {
    const h = setup(t);
    const response = deferred();
    h.symbols = () => response.promise;
    const result = h.lenses();
    h.edit(h.a);
    response.resolve([symbol()]);
    assert.equal((await result).length, 0);
});

test('rejects changed document versions even before an edit event is delivered', async t => {
    const h = setup(t);
    const lens = (await h.lenses())[0];
    h.a.version++;
    await h.resolve(lens);
    assert.equal(h.referenceCalls, 0);
});

test('respects cancellation both before discovery and when reading cached references', async t => {
    const h = setup(t);
    const cancelled = { isCancellationRequested: true };
    assert.equal((await h.lenses(h.a, cancelled)).length, 0);
    assert.equal(h.symbolCalls, 0);
    await h.count();
    const lens = (await h.lenses())[0];
    await h.resolve(lens, cancelled);
    assert.equal(lens.command, undefined);
    assert.equal(h.referenceCalls, 1);
});

test('logs reference failures without caching them as zero and allows retry', async t => {
    const h = setup(t);
    h.references = async () => { throw new Error('Provider restarting'); };
    const lens = await h.resolve((await h.lenses())[0]);
    assert.equal(lens.command.title, 'References unavailable');
    assert.equal(lens.command.command, 'pythonReferenceLens.refresh');
    assert.match(h.logs[0], /Provider restarting/);
    h.references = async () => [location('b.py')];
    assert.equal(await h.count(), '1 reference');
    assert.equal(h.referenceCalls, 2);
});

test('handles absent reference results and symbol provider failures', async t => {
    const h = setup(t);
    h.references = async () => undefined;
    assert.equal(await h.count(), 'References unavailable');
    h.symbols = async () => { throw new Error('Symbols unavailable'); };
    assert.equal((await h.lenses()).length, 0);
    assert.equal(h.logs.length, 2);
});

for (const event of ['create', 'diskChange', 'delete', 'save', 'close', 'folders']) {
    test(`${event} events invalidate counts from other files`, async t => {
        const h = setup(t);
        await h.count();
        h.events[event].fire(h.b);
        h.tick(400);
        h.references = async () => [];
        assert.equal(await h.count(), '0 references');
        assert.equal(h.referenceCalls, 2);
        assert.equal(h.refreshes, 1);
    });
}

test('a closed and reopened document cannot reuse its old version-one cache', async t => {
    const h = setup(t);
    await h.count();
    h.a.isClosed = true;
    h.events.close.fire(h.a);
    h.a.isClosed = false;
    h.a.version = 1;
    h.references = async () => [];
    assert.equal(await h.count(), '0 references');
    assert.equal(h.referenceCalls, 2);
});

test('configuration changes refresh immediately and preserve enabled/zero settings', async t => {
    const h = setup(t);
    h.references = async () => [];
    assert.equal(await h.count(), '0 references');
    h.config.showZeroReferences = false;
    h.events.config.fire({ affectsConfiguration: name => name === 'pythonReferenceLens' });
    assert.equal(h.refreshes, 1);
    assert.equal(await h.count(), '');
    h.config.enabled = false;
    assert.equal((await h.lenses()).length, 0);
});

test('disposal cancels timers, suppresses late results and removes event listeners', async t => {
    const h = setup(t);
    const response = deferred();
    h.references = () => response.promise;
    const lens = (await h.lenses())[0];
    const result = h.resolve(lens);
    h.edit();
    h.dispose();
    response.resolve([location('b.py')]);
    await result;
    h.tick(1000);
    assert.equal(lens.command, undefined);
    assert.equal(h.refreshes, 0);
    assert.equal((await h.lenses()).length, 0);
    for (const event of Object.values(h.events)) assert.equal(event.listeners.size, 0);
});
