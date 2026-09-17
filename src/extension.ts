import * as vscode from 'vscode';

interface LensData {
    uri: vscode.Uri;
    position: vscode.Position;
    documentVersion: number;
    generation: number;
}

class PythonReferenceCodeLens extends vscode.CodeLens {
    constructor(
        range: vscode.Range,
        public readonly data: LensData
    ) {
        super(range);
    }
}

class PythonReferenceLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses = this.changeEmitter.event;

    private readonly cache = new Map<string, vscode.Location[]>();
    private readonly pending = new Map<string, Promise<vscode.Location[] | undefined>>();
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
                lenses.push(
                    new PythonReferenceCodeLens(new vscode.Range(position, position), {
                        ...snapshot,
                        position
                    })
                );
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

        const { uri, position } = codeLens.data;
        const references = await this.getReferences(codeLens.data);

        if (token.isCancellationRequested || !this.isCurrent(codeLens.data)) {
            return codeLens;
        }
        if (references === undefined) {
            codeLens.command = {
                title: 'References unavailable',
                tooltip: 'Click to retry. See the Python Reference Lens output for details.',
                command: 'pythonReferenceLens.refresh'
            };
            return codeLens;
        }

        const config = vscode.workspace.getConfiguration('pythonReferenceLens', uri);
        const showZeroReferences = config.get<boolean>('showZeroReferences', true);

        if (references.length === 0 && !showZeroReferences) {
            codeLens.command = {
                title: '',
                command: ''
            };
            return codeLens;
        }

        const title =
            references.length === 1
                ? '1 reference'
                : `${references.length} references`;

        codeLens.command = {
            title,
            tooltip:
                references.length === 0
                    ? 'No references found by the active Python language provider'
                    : 'Show references',
            command: 'editor.action.showReferences',
            arguments: [uri, position, references]
        };

        return codeLens;
    }

    private async getReferences(data: LensData): Promise<vscode.Location[] | undefined> {
        const { uri, position, documentVersion, generation } = data;
        const key = `${generation}::${uri.toString()}::${documentVersion}::${position.line}:${position.character}`;
        const cached = this.cache.get(key);
        if (cached !== undefined) {
            return cached;
        }
        const existing = this.pending.get(key);
        if (existing) {
            return existing;
        }

        // Cancellation belongs to each lens, not to this shared provider request.
        const request = this.fetchReferences(data);
        this.pending.set(key, request);
        try {
            return await request;
        } finally {
            if (this.pending.get(key) === request) {
                this.pending.delete(key);
            }
        }
    }

    private async fetchReferences(data: LensData): Promise<vscode.Location[] | undefined> {
        try {
            const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeReferenceProvider', data.uri, data.position
            );
            if (!this.isCurrent(data)) {
                return undefined;
            }
            if (locations === undefined) {
                this.logError('References', 'The language provider returned no result.');
                return undefined;
            }
            const references = this.deduplicateLocations(locations);
            const { uri, position, documentVersion, generation } = data;
            const key = `${generation}::${uri.toString()}::${documentVersion}::${position.line}:${position.character}`;
            // Bound memory usage when browsing many documents without editing them.
            if (this.cache.size >= 500) {
                const oldestKey = this.cache.keys().next().value;
                if (oldestKey !== undefined) {
                    this.cache.delete(oldestKey);
                }
            }
            this.cache.set(key, references);
            return references;
        } catch (error) {
            this.logError('References', error);
            return undefined;
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

                lenses.push(
                    new PythonReferenceCodeLens(new vscode.Range(position, position), {
                        ...snapshot,
                        position
                    })
                );
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

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('Python Reference Lens');
    const provider = new PythonReferenceLensProvider(output);
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.{py,pyi,pyw}');

    context.subscriptions.push(
        output,
        provider,
        watcher,
        watcher.onDidCreate(() => provider.scheduleRefresh()),
        watcher.onDidChange(() => provider.scheduleRefresh()),
        watcher.onDidDelete(() => provider.scheduleRefresh()),
        vscode.languages.registerCodeLensProvider(
            { language: 'python', scheme: 'file' },
            provider
        ),
        vscode.commands.registerCommand('pythonReferenceLens.refresh', () => provider.refresh()),
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

export function deactivate(): void {
    // All disposables are owned by ExtensionContext.
}
