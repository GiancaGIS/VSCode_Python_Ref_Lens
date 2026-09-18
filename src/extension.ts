import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { PeekAppearance } from './peekAppearance';

type LensKind = 'references' | 'calls' | 'otherReferences' | 'implementations' | 'incoming';
interface IncomingSummary {
    calls: vscode.Location[];
    callers: vscode.Location[];
}
interface Results {
    references: vscode.Location[];
    implementations: vscode.Location[];
    incoming: IncomingSummary;
}
const defaultTestFilePatterns = [
    '**/{test,tests}/**', '**/test_*.py', '**/*_test.py', '**/conftest.py'
];

interface LensData {
    uri: vscode.Uri;
    position: vscode.Position;
    documentVersion: number;
    generation: number;
}

class PythonReferenceCodeLens extends vscode.CodeLens {
    constructor(
        range: vscode.Range,
        public readonly data: LensData,
        public readonly kind: LensKind
    ) {
        super(range);
    }
}

class PythonReferenceLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this.changeEmitter.event;

    private readonly cache = new Map<string, Results[keyof Results]>();
    private readonly pending = new Map<string, Promise<Results[keyof Results] | undefined>>();
    private generation = 0;
    private refreshTimer: ReturnType<typeof setTimeout> | undefined;
    private disposed = false;

    constructor(private readonly output: vscode.OutputChannel) {}

    public dispose(): void {
        this.disposed = true;
        this.clearRefreshTimer();
        this.invalidateCache();
        this.changeEmitter.dispose();
    }

    public refresh(): void {
        if (this.disposed) {
            return;
        }
        this.clearRefreshTimer();
        this.invalidateCache();
        this.changeEmitter.fire();
    }

    public scheduleRefresh(): void {
        if (this.disposed) {
            return;
        }
        // A caller can be in any file. Invalidate immediately, but coalesce UI updates.
        this.invalidateCache();
        this.clearRefreshTimer();
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            this.changeEmitter.fire();
        }, 400);
    }

    private invalidateCache(): void {
        this.generation++;
        this.cache.clear();
        this.pending.clear();
    }

    private clearRefreshTimer(): void {
        if (this.refreshTimer !== undefined) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    private isCurrent(data: LensData): boolean {
        const document = vscode.workspace.textDocuments.find(
            candidate => candidate.uri.toString() === data.uri.toString()
        );
        return !this.disposed && data.generation === this.generation &&
            document !== undefined && !document.isClosed && document.version === data.documentVersion;
    }

    private logError(operation: string, error: unknown): void {
        if (!this.disposed) {
            this.output.appendLine(`[${operation}] ${String(error)}`);
        }
    }

    async provideCodeLenses(
        document: vscode.TextDocument,
        token: vscode.CancellationToken
    ): Promise<vscode.CodeLens[]> {
        const config = vscode.workspace.getConfiguration('pythonReferenceLens', document.uri);
        if (this.disposed || token.isCancellationRequested || !config.get<boolean>('enabled', true)) {
            return [];
        }

        const snapshot: LensData = {
            uri: document.uri,
            position: new vscode.Position(0, 0),
            documentVersion: document.version,
            generation: this.generation
        };
        let symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[] | undefined;
        try {
            symbols = await vscode.commands.executeCommand<
                vscode.DocumentSymbol[] | vscode.SymbolInformation[]
            >('vscode.executeDocumentSymbolProvider', document.uri);
        } catch (error) {
            this.logError('Document symbols', error);
            return [];
        }

        if (!symbols || token.isCancellationRequested || !this.isCurrent(snapshot)) {
            return [];
        }

        const lenses: vscode.CodeLens[] = [];

        if (this.isDocumentSymbolArray(symbols)) {
            this.collectDocumentSymbols(snapshot, symbols, lenses);
        } else {
            for (const symbol of symbols) {
                if (!this.isFunctionLike(symbol.kind) ||
                    symbol.location.uri.toString() !== document.uri.toString()) {
                    continue;
                }

                const position = symbol.location.range.start;
                this.addLenses({ ...snapshot, position }, lenses);
            }
        }

        return lenses;
    }

    async resolveCodeLens(
        codeLens: vscode.CodeLens,
        token: vscode.CancellationToken
    ): Promise<vscode.CodeLens> {
        if (!(codeLens instanceof PythonReferenceCodeLens) || token.isCancellationRequested ||
            !this.isCurrent(codeLens.data)) {
            return codeLens;
        }

        const { data, kind } = codeLens;
        let locations: vscode.Location[] | undefined;
        let label: string;
        let unavailable: string;
        let tooltip: string;
        switch (kind) {
            case 'references':
                locations = await this.getReferences(data);
                label = 'reference';
                unavailable = 'References unavailable';
                tooltip = 'Show all references';
                break;
            case 'implementations':
                locations = await this.getImplementations(data);
                label = 'implementation / override';
                unavailable = 'Implementations unavailable';
                tooltip = 'Show implementations and overrides reported by the language provider';
                break;
            case 'incoming':
            case 'calls': {
                const incoming = await this.getIncoming(data);
                locations = kind === 'calls' ? incoming?.calls : incoming?.callers;
                label = kind === 'calls' ? 'call' : 'caller';
                unavailable = kind === 'calls' ? 'Calls unavailable' : 'Call hierarchy unavailable';
                tooltip = kind === 'calls' ? 'Show call sites reported by the language provider' : 'Open incoming call hierarchy';
                break;
            }
            case 'otherReferences': {
                const [references, incoming] = await Promise.all([
                    this.getReferences(data), this.getIncoming(data)
                ]);
                if (references !== undefined && incoming !== undefined) {
                    const callsByUri = new Map<string, vscode.Range[]>();
                    for (const call of incoming.calls) {
                        const key = call.uri.toString();
                        const ranges = callsByUri.get(key) ?? [];
                        ranges.push(call.range);
                        callsByUri.set(key, ranges);
                    }
                    locations = references.filter(reference =>
                        !(callsByUri.get(reference.uri.toString()) ?? []).some(range =>
                            this.rangesOverlap(reference.range, range))
                    );
                }
                label = 'other reference';
                unavailable = 'Other references unavailable';
                tooltip = 'Show references not identified as call sites by the language provider';
                break;
            }
        }

        if (token.isCancellationRequested || !this.isCurrent(data)) {
            return codeLens;
        }
        if (locations === undefined) {
            codeLens.command = {
                title: unavailable,
                tooltip: 'The provider may not support this feature. Click to retry; see the Python Reference Lens output for details.',
                command: 'pythonReferenceLens.refresh'
            };
            return codeLens;
        }

        const config = vscode.workspace.getConfiguration('pythonReferenceLens', data.uri);
        if (locations.length === 0 && !config.get<boolean>('showZeroReferences', true)) {
            codeLens.command = { title: '', command: '' };
            return codeLens;
        }

        const plural = kind === 'implementations' ? 'implementations / overrides' : `${label}s`;
        let title = `${locations.length} ${locations.length === 1 ? label : plural}`;
        if (kind === 'references' && config.get<boolean>('showReferenceBreakdown', true)) {
            const tests = locations.filter(location => this.isTestFile(location.uri)).length;
            title += ` (${locations.length - tests} production, ${tests} test)`;
            tooltip += '; test files are classified using pythonReferenceLens.testFilePatterns';
        }
        codeLens.command = {
            title,
            tooltip,
            command: kind === 'incoming' ? 'pythonReferenceLens.showIncomingCalls' : 'editor.action.showReferences',
            arguments: kind === 'incoming' ? [data] : [data.uri, data.position, locations]
        };
        return codeLens;
    }

    public async showIncomingCalls(data?: LensData): Promise<void> {
        // The cursor may have moved since the lens was clicked. Always anchor the
        // native hierarchy to the selected symbol, and explicitly choose incoming.
        if (!data || !this.isCurrent(data)) {
            return;
        }
        try {
            await vscode.window.showTextDocument(data.uri, {
                selection: new vscode.Range(data.position, data.position), preview: true
            });
            if (!this.isCurrent(data)) {
                return;
            }
            await vscode.commands.executeCommand('editor.showCallHierarchy');
            await vscode.commands.executeCommand('editor.showIncomingCalls');
        } catch (error) {
            this.logError('Incoming call hierarchy', error);
            void vscode.window.showErrorMessage('Unable to open incoming calls. See the Python Reference Lens output for details.');
        }
    }

    private isTestFile(uri: vscode.Uri): boolean {
        // Resolve settings in the caller's folder, including multi-root workspaces.
        const config = vscode.workspace.getConfiguration('pythonReferenceLens', uri);
        const patterns = config.get<string[]>('testFilePatterns', defaultTestFilePatterns);
        const path = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, '/');
        return patterns.some(pattern => minimatch(path, pattern, { dot: true, nonegate: true, nocomment: true }));
    }

    private async getResult<K extends keyof Results>(
        data: LensData, operation: K, fetch: () => Promise<Results[K] | undefined>
    ): Promise<Results[K] | undefined> {
        const { uri, position, documentVersion, generation } = data;
        const key = `${operation}::${generation}::${uri.toString()}::${documentVersion}::${position.line}:${position.character}`;
        const cached = this.cache.get(key) as Results[K] | undefined;
        if (cached !== undefined) {
            return cached;
        }
        const existing = this.pending.get(key);
        if (existing) {
            return existing as Promise<Results[K] | undefined>;
        }

        // Cancellation belongs to each lens, not to this shared provider request.
        const request = (async () => {
            try {
                const result = await fetch();
                if (!this.isCurrent(data)) {
                    return undefined;
                }
                if (result === undefined) {
                    this.logError(operation, 'The language provider returned no result or does not support this feature.');
                    return undefined;
                }
                // Bound memory usage across all provider operations.
                if (this.cache.size >= 500) {
                    const oldestKey = this.cache.keys().next().value;
                    if (oldestKey !== undefined) this.cache.delete(oldestKey);
                }
                this.cache.set(key, result);
                return result;
            } catch (error) {
                this.logError(operation, error);
                return undefined;
            }
        })();
        this.pending.set(key, request);
        try {
            return await request;
        } finally {
            if (this.pending.get(key) === request) {
                this.pending.delete(key);
            }
        }
    }

    private getReferences(data: LensData): Promise<vscode.Location[] | undefined> {
        return this.getResult(data, 'references', async () => {
            const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider', data.uri, data.position
            );
            return locations && this.deduplicateLocations(locations.filter(location => !this.isDeclaration(location, data)));
        });
    }

    private getImplementations(data: LensData): Promise<vscode.Location[] | undefined> {
        return this.getResult(data, 'implementations', async () => {
            const targets = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
                'vscode.executeImplementationProvider', data.uri, data.position
            );
            return targets && this.deduplicateLocations(targets.map(target =>
                'targetUri' in target
                    ? new vscode.Location(target.targetUri, target.targetSelectionRange ?? target.targetRange)
                    : target
            ).filter(location => !this.isDeclaration(location, data)));
        });
    }

    private getIncoming(data: LensData): Promise<IncomingSummary | undefined> {
        return this.getResult(data, 'incoming', async () => {
            const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
                'vscode.prepareCallHierarchy', data.uri, data.position
            );
            if (!items?.length || !this.isCurrent(data)) return undefined;
            const results = await Promise.all(items.map(item =>
                vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', item)
            ));
            // A partial response cannot establish a reliable count.
            if (results.some(result => result === undefined)) return undefined;
            const incoming = results.flatMap(result => result ?? []);
            return {
                calls: this.deduplicateLocations(incoming.flatMap(call =>
                    call.fromRanges.map(range => new vscode.Location(call.from.uri, range))
                )),
                callers: this.deduplicateLocations(incoming.map(call =>
                    new vscode.Location(call.from.uri, call.from.selectionRange)
                ))
            };
        });
    }

    private isDeclaration(location: vscode.Location, data: LensData): boolean {
        return location.uri.toString() === data.uri.toString() && location.range.contains(data.position);
    }

    private rangesOverlap(first: vscode.Range, second: vscode.Range): boolean {
        return first.start.isBefore(second.end) && second.start.isBefore(first.end) ||
            first.start.isEqual(second.start);
    }

    private addLenses(data: LensData, lenses: vscode.CodeLens[]): void {
        const config = vscode.workspace.getConfiguration('pythonReferenceLens', data.uri);
        const kinds: LensKind[] = ['references'];
        if (config.get<boolean>('showCalls', true)) kinds.push('calls', 'otherReferences');
        if (config.get<boolean>('showImplementations', true)) kinds.push('implementations');
        if (config.get<boolean>('showIncomingCalls', true)) kinds.push('incoming');
        for (const kind of kinds) {
            lenses.push(new PythonReferenceCodeLens(new vscode.Range(data.position, data.position), data, kind));
        }
    }

    private collectDocumentSymbols(
        snapshot: LensData,
        symbols: vscode.DocumentSymbol[],
        lenses: vscode.CodeLens[]
    ): void {
        for (const symbol of symbols) {
            if (this.isFunctionLike(symbol.kind)) {
                // selectionRange normally points at the actual symbol name, which is
                // a better semantic lookup position than the beginning of `def`.
                const position = symbol.selectionRange.start;

                this.addLenses({ ...snapshot, position }, lenses);
            }

            if (symbol.children.length > 0) {
                this.collectDocumentSymbols(snapshot, symbol.children, lenses);
            }
        }
    }

    private isFunctionLike(kind: vscode.SymbolKind): boolean {
        return kind === vscode.SymbolKind.Function || kind === vscode.SymbolKind.Method;
    }

    private isDocumentSymbolArray(
        symbols: vscode.DocumentSymbol[] | vscode.SymbolInformation[]
    ): symbols is vscode.DocumentSymbol[] {
        return symbols.length === 0 || 'selectionRange' in symbols[0];
    }

    private deduplicateLocations(locations: vscode.Location[]): vscode.Location[] {
        const seen = new Set<string>();
        const result: vscode.Location[] = [];

        for (const location of locations) {
            const key = [
                location.uri.toString(),
                location.range.start.line,
                location.range.start.character,
                location.range.end.line,
                location.range.end.character
            ].join(':');

            if (!seen.has(key)) {
                seen.add(key);
                result.push(location);
            }
        }

        return result;
    }
}

let peekAppearance: PeekAppearance | undefined;

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('Python Reference Lens');
    const provider = new PythonReferenceLensProvider(output);
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{py,pyi,pyw}');
    peekAppearance = new PeekAppearance(context.workspaceState, output);
    void peekAppearance.sync();

    context.subscriptions.push(
        output,
        provider,
        peekAppearance,
        watcher,
        watcher.onDidCreate(() => provider.scheduleRefresh()),
        watcher.onDidChange(() => provider.scheduleRefresh()),
        watcher.onDidDelete(() => provider.scheduleRefresh()),
        vscode.languages.registerCodeLensProvider(
            { language: 'python', scheme: 'file' },
            provider
        ),
        vscode.commands.registerCommand('pythonReferenceLens.refresh', () => provider.refresh()),
        vscode.commands.registerCommand('pythonReferenceLens.showIncomingCalls', (data?: LensData) => provider.showIncomingCalls(data)),
        vscode.workspace.onDidChangeTextDocument(event => {
            if (event.document.languageId === 'python' && event.contentChanges.length > 0) {
                provider.scheduleRefresh();
            }
        }),
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.languageId === 'python') {
                provider.scheduleRefresh();
            }
        }),
        vscode.workspace.onDidCloseTextDocument(document => {
            if (document.languageId === 'python') {
                provider.scheduleRefresh();
            }
        }),
        vscode.workspace.onDidChangeWorkspaceFolders(() => provider.scheduleRefresh()),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('pythonReferenceLens')) {
                provider.refresh();
            }
        })
    );
}

export async function deactivate(): Promise<void> {
    // Await settings restoration; the journal also covers interrupted shutdowns.
    await peekAppearance?.restore();
    peekAppearance = undefined;
}
