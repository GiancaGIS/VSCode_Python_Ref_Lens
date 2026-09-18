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
    isBefore(other) { return this.line < other.line || this.line === other.line && this.character < other.character; }
    isEqual(other) { return this.line === other.line && this.character === other.character; }
}

class Range {
    constructor(start, end) { Object.assign(this, { start, end }); }
    contains(position) { return !position.isBefore(this.start) && !this.end.isBefore(position); }
}

class Location {
    constructor(uri, range) { Object.assign(this, { uri, range }); }
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
        'edit', 'save', 'close', 'folders', 'config', 'create', 'diskChange', 'delete', 'theme'
    ].map(name => [name, new EventEmitter()]));
    const a = document('a.py');
    const b = document('b.py');
    const timers = new Map();
    let now = 0, timerId = 0;
    const h = {
        a, b, events, logs: [], referenceCalls: 0, symbolCalls: 0, refreshes: 0,
        config: { enabled: true, showZeroReferences: true, showCalls: false,
            showReferenceBreakdown: false, showImplementations: false, showIncomingCalls: false },
        commands: new Map(), executed: [], shownDocuments: [],
        prepareCalls: 0, incomingCalls: 0, implementationCalls: 0,
        prepare: async () => [symbol()],
        incoming: async () => [],
        implementations: async () => [],
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
        Position, Range, Location, CodeLens, EventEmitter,
        SymbolKind: { Function: 11, Method: 5, Class: 4 },
        window: {
            onDidChangeActiveColorTheme: events.theme.event,
            showTextDocument: async (...args) => { h.shownDocuments.push(args); },
            showErrorMessage: async message => { h.logs.push(message); },
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
                h.commands.set(name, callback);
                if (name === 'pythonReferenceLens.refresh') h.refresh = callback;
                return { dispose() {} };
            },
            executeCommand: async (name, ...args) => {
                h.executed.push(name);
                if (name === 'vscode.prepareCallHierarchy') {
                    h.prepareCalls++;
                    return h.prepare(...args);
                }
                if (name === 'vscode.provideIncomingCalls') {
                    h.incomingCalls++;
                    return h.incoming(...args);
                }
                if (name === 'vscode.executeImplementationProvider') {
                    h.implementationCalls++;
                    return h.implementations(...args);
                }
                if (name === 'editor.showCallHierarchy' || name === 'editor.showIncomingCalls') return;
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
            asRelativePath: value => value.toString().replace('file:///workspace/', ''),
            getConfiguration: (_section, resource) => ({ get: (key, fallback) =>
                h.resourceConfig?.(resource)?.[key] ?? h.config[key] ?? fallback }),
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
            if (name === 'minimatch') return require('minimatch');
            if (name === './peekAppearance') {
                const moduleExports = {};
                vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../out/peekAppearance.js'), 'utf8'), {
                    exports: moduleExports, require: () => vscode
                });
                return moduleExports;
            }
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
    exports.activate({ subscriptions, workspaceState: { get: (_key, fallback) => fallback, update: async () => {} } });
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

function caller(name, declarationLine, callLines) {
    const declaration = location(name, declarationLine);
    return {
        from: { name: 'caller', uri: declaration.uri, selectionRange: declaration.range, range: declaration.range },
        fromRanges: callLines.map(line => location(name, line).range)
    };
}

function enableFeatures(h) {
    for (const key of ['showCalls', 'showReferenceBreakdown', 'showImplementations', 'showIncomingCalls']) {
        delete h.config[key]; // Exercise the actual extension defaults.
    }
    h.byKind = async kind => (await h.lenses()).find(lens => lens.kind === kind);
    h.resolveKind = async kind => h.resolve(await h.byKind(kind));
}

test('all features are enabled by default and can be disabled independently', async t => {
    const h = setup(t);
    enableFeatures(h);
    assert.deepEqual(Array.from(await h.lenses(), lens => lens.kind),
        ['references', 'calls', 'otherReferences', 'implementations', 'incoming']);
    h.config.showCalls = false;
    assert.deepEqual(Array.from(await h.lenses(), lens => lens.kind), ['references', 'implementations', 'incoming']);
    h.config.showImplementations = false;
    h.config.showIncomingCalls = false;
    await h.count();
    assert.equal(h.prepareCalls, 0);
    assert.equal(h.implementationCalls, 0);
});

test('separates semantic call sites from imports/callback references and distinct callers', async t => {
    const h = setup(t);
    enableFeatures(h);
    h.references = async () => [location('a.py'), location('b.py', 2), location('b.py', 3), location('b.py', 8)];
    const entry = caller('b.py', 1, [2, 3]);
    h.incoming = async () => [entry, entry];
    const lenses = await h.lenses();
    await Promise.all(lenses.map(lens => h.resolve(lens)));
    const byKind = kind => lenses.find(lens => lens.kind === kind).command;
    assert.equal(byKind('references').title, '3 references (3 production, 0 test)');
    assert.equal(byKind('calls').title, '2 calls');
    assert.equal(byKind('otherReferences').title, '1 other reference');
    assert.equal(byKind('incoming').title, '1 caller');
    assert.deepEqual(Array.from(byKind('calls').arguments[2], item => item.range.start.line), [2, 3]);
    assert.equal(byKind('otherReferences').arguments[2][0].range.start.line, 8);
    assert.equal(byKind('incoming').command, 'pythonReferenceLens.showIncomingCalls');
    assert.equal(h.referenceCalls, 1);
    assert.equal(h.prepareCalls, 1);
    assert.equal(h.incomingCalls, 1);
    await h.resolveKind('calls');
    assert.equal(h.prepareCalls, 1);
});

test('matches overlapping call/reference ranges, but not adjacent ranges or other files', async t => {
    const h = setup(t);
    enableFeatures(h);
    h.references = async () => [location('b.py', 2), location('c.py', 2), location('b.py', 3)];
    const entry = caller('b.py', 1, []);
    entry.fromRanges = [
        new Range(new Position(2, 2), new Position(2, 10)),
        new Range(new Position(3, 5), new Position(3, 10))
    ];
    h.incoming = async () => [entry];
    const lens = await h.resolveKind('otherReferences');
    assert.equal(lens.command.title, '2 other references');
    assert.equal(lens.command.arguments[2][0].uri.toString(), uri('c.py').toString());
});

test('counts recursive call sites and merges all prepared hierarchy items', async t => {
    const h = setup(t);
    enableFeatures(h);
    h.prepare = async () => [{ name: 'first' }, { name: 'second' }];
    h.incoming = async item => item.name === 'first'
        ? [caller('a.py', 0, [3])]
        : [caller('a.py', 0, [3]), caller('b.py', 1, [5])];
    assert.equal((await h.resolveKind('calls')).command.title, '2 calls');
    assert.equal((await h.resolveKind('incoming')).command.title, '2 callers');
    assert.equal(h.incomingCalls, 2);
});

test('classifies test directories, filenames and conftest without matching unrelated names', async t => {
    const h = setup(t);
    enableFeatures(h);
    h.references = async () => [
        'tests/unit.py', 'test/unit.py', 'pkg/tests/unit.py', 'test_root.py',
        'pkg/test_unit.py', 'pkg/unit_test.py', 'conftest.py', '.hidden/tests/unit.py',
        'src/contest.py', 'src/testing.py', 'src/tests_helpers.py', 'src/main.py'
    ].map(name => location(name));
    assert.equal(await h.count(), '12 references (4 production, 8 test)');
});

test('uses custom test patterns from each caller workspace folder and refreshes classifications', async t => {
    const h = setup(t);
    enableFeatures(h);
    h.references = async () => [location('one/qa/check.py'), location('two/specs/check.py'), location('two/tests/check.py')];
    h.resourceConfig = resource => ({ testFilePatterns: resource.toString().includes('/one/') ? ['**/qa/**'] : ['**/specs/**'] });
    assert.equal(await h.count(), '3 references (1 production, 2 test)');
    h.resourceConfig = () => ({ testFilePatterns: [] });
    h.events.config.fire({ affectsConfiguration: () => true });
    assert.equal(await h.count(), '3 references (3 production, 0 test)');
});

test('normalizes implementation LocationLinks, deduplicates and excludes the original definition', async t => {
    const h = setup(t);
    enableFeatures(h);
    const target = location('subclass.py', 7);
    const link = { targetUri: target.uri, targetRange: location('subclass.py', 6).range, targetSelectionRange: target.range };
    h.implementations = async () => [location('a.py'), target, link,
        { targetUri: uri('other.py'), targetRange: location('other.py', 10).range }];
    const lens = await h.resolveKind('implementations');
    assert.equal(lens.command.title, '2 implementations / overrides');
    assert.equal(lens.command.command, 'editor.action.showReferences');
    assert.equal(lens.command.arguments[2][0].range.start.line, 7);
    assert.equal(lens.command.arguments[2][1].range.start.line, 10);
    await h.resolveKind('implementations');
    assert.equal(h.implementationCalls, 1);
});

test('opens the native incoming hierarchy at the lens symbol and ignores stale click commands', async t => {
    const h = setup(t);
    enableFeatures(h);
    const lens = await h.resolveKind('incoming');
    await h.commands.get(lens.command.command)(...lens.command.arguments);
    assert.equal(h.shownDocuments.length, 1);
    assert.equal(h.shownDocuments[0][0], h.a.uri);
    assert.equal(h.shownDocuments[0][1].selection.start.character, 4);
    assert.deepEqual(h.executed.slice(-2), ['editor.showCallHierarchy', 'editor.showIncomingCalls']);
    h.edit();
    await h.commands.get(lens.command.command)(...lens.command.arguments);
    assert.equal(h.shownDocuments.length, 1);
});

test('does not label unknown hierarchy results as zero calls or non-call references', async t => {
    const h = setup(t);
    enableFeatures(h);
    h.prepare = async () => [];
    assert.equal((await h.resolveKind('calls')).command.title, 'Calls unavailable');
    assert.equal((await h.resolveKind('otherReferences')).command.title, 'Other references unavailable');
    assert.equal((await h.resolveKind('incoming')).command.title, 'Call hierarchy unavailable');
    assert.equal(await h.count(), '1 reference (1 production, 0 test)');
    h.prepare = async () => [symbol()];
    h.incoming = async () => [];
    assert.equal((await h.resolveKind('calls')).command.title, '0 calls');
    assert.equal((await h.resolveKind('otherReferences')).command.title, '1 other reference');
});

test('a partial hierarchy failure is not cached or counted as a complete result', async t => {
    const h = setup(t);
    enableFeatures(h);
    h.prepare = async () => [{ name: 'ok' }, { name: 'missing' }];
    h.incoming = async item => item.name === 'ok' ? [caller('b.py', 1, [2])] : undefined;
    assert.equal((await h.resolveKind('calls')).command.title, 'Calls unavailable');
    h.incoming = async () => [caller('b.py', 1, [2])];
    assert.equal((await h.resolveKind('calls')).command.title, '1 call');
    assert.equal(h.prepareCalls, 2);
});

for (const [kind, hook, unavailable] of [
    ['calls', 'prepare', 'Calls unavailable'],
    ['incoming', 'incoming', 'Call hierarchy unavailable'],
    ['implementations', 'implementations', 'Implementations unavailable']
]) {
    test(`${kind} failures can be retried without losing references`, async t => {
        const h = setup(t);
        enableFeatures(h);
        const original = h[hook];
        h[hook] = async () => { throw new Error('Provider restarting'); };
        const lens = await h.resolveKind(kind);
        assert.equal(lens.command.title, unavailable);
        assert.equal(lens.command.command, 'pythonReferenceLens.refresh');
        assert.match(h.logs[0], /Provider restarting/);
        assert.equal(await h.count(), '1 reference (1 production, 0 test)');
        h[hook] = original;
        assert.match((await h.resolveKind(kind)).command.title, /^0 /);
    });
}

for (const [kind, hook] of [['calls', 'incoming'], ['implementations', 'implementations']]) {
    test(`${kind} requests share work across cancellation and discard old generations`, async t => {
        const h = setup(t);
        enableFeatures(h);
        const response = deferred();
        let requests = 0;
        h[hook] = () => { requests++; return response.promise; };
        const first = await h.byKind(kind);
        const second = await h.byKind(kind);
        const cancelled = token();
        const results = [h.resolve(first, cancelled), h.resolve(second)];
        cancelled.isCancellationRequested = true;
        response.resolve([]);
        await Promise.all(results);
        assert.equal(requests, 1);
        assert.equal(first.command, undefined);
        assert.match(second.command.title, /^0 /);

        h.refresh();
        const late = deferred();
        h[hook] = () => late.promise;
        const staleLens = await h.byKind(kind);
        const pending = h.resolve(staleLens);
        // Let call hierarchy preparation finish before invalidation.
        await new Promise(resolve => setImmediate(resolve));
        h.edit();
        h[hook] = async () => [];
        assert.match((await h.resolveKind(kind)).command.title, /^0 /);
        late.resolve(kind === 'calls' ? [caller('b.py', 1, [2])] : [location('b.py')]);
        await pending;
        assert.equal(staleLens.command, undefined);
        assert.match((await h.resolveKind(kind)).command.title, /^0 /);
    });
}

test('hide-zero applies to every new count without suppressing lookup failures', async t => {
    const h = setup(t);
    enableFeatures(h);
    h.config.showZeroReferences = false;
    h.references = async () => [];
    for (const lens of await h.lenses()) {
        assert.equal((await h.resolve(lens)).command.title, '');
    }
    h.refresh();
    h.implementations = async () => undefined;
    assert.equal((await h.resolveKind('implementations')).command.title, 'Implementations unavailable');
});
