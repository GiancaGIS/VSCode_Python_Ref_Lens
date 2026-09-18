import * as vscode from 'vscode';

type Colors = Record<string, string>;
type Customizations = Record<string, string | Colors>;
type Style = 'theme' | 'accented' | 'contrast' | 'custom';
interface Snapshot {
    themeKey: string;
    hadBlock: boolean;
    hadConfiguration: boolean;
    previous: Record<string, string | null>;
    applied: Colors;
}

const stateKey = 'peekAppearance.backup.v1';
const customKeys: Record<string, string[]> = {
    border: ['peekView.border', 'peekViewEditor.matchHighlightBorder'],
    titleBackground: ['peekViewTitle.background'],
    titleForeground: ['peekViewTitleLabel.foreground', 'peekViewTitleDescription.foreground'],
    editorBackground: ['peekViewEditor.background', 'peekViewEditorGutter.background'],
    resultsBackground: ['peekViewResult.background'],
    resultForeground: ['peekViewResult.fileForeground', 'peekViewResult.lineForeground'],
    selectionBackground: ['peekViewResult.selectionBackground'],
    selectionForeground: ['peekViewResult.selectionForeground'],
    matchBackground: ['peekViewEditor.matchHighlightBackground', 'peekViewResult.matchHighlightBackground']
};

export function peekColors(style: Style, kind: vscode.ColorThemeKind, custom: Colors = {}): Colors {
    if (style === 'theme') return {};
    const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
    const highContrast = kind === vscode.ColorThemeKind.HighContrast || kind === vscode.ColorThemeKind.HighContrastLight;
    const palette: Colors = highContrast ? {
        border: light ? '#0F4A85' : '#F3DD00', titleBackground: light ? '#E5E5E5' : '#181818',
        titleForeground: light ? '#000000' : '#FFFFFF', editorBackground: light ? '#FFFFFF' : '#000000',
        resultsBackground: light ? '#F4F4F4' : '#101010', resultForeground: light ? '#000000' : '#FFFFFF',
        selectionBackground: light ? '#0F4A85' : '#F3DD00', selectionForeground: light ? '#FFFFFF' : '#000000',
        matchBackground: light ? '#005FB830' : '#F3DD0030'
    } : light ? {
        border: '#0066B8', titleBackground: '#DCE9FB', titleForeground: '#12263A',
        editorBackground: '#F2F6FC', resultsBackground: '#E7EEF8', resultForeground: '#203449',
        selectionBackground: '#145DA0', selectionForeground: '#FFFFFF', matchBackground: '#B879002B'
    } : {
        border: '#64B5F6', titleBackground: '#173D60', titleForeground: '#F1F7FF',
        editorBackground: '#182536', resultsBackground: '#213248', resultForeground: '#DAE7F5',
        selectionBackground: '#315C85', selectionForeground: '#FFFFFF', matchBackground: '#FFD43B33'
    };
    if (style === 'custom') {
        for (const [key, value] of Object.entries(custom)) {
            // Validate at runtime too: settings can be hand-edited despite the schema.
            if (key in customKeys && typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) {
                palette[key] = value;
            }
        }
    }
    const colors: Colors = {};
    for (const [key, ids] of Object.entries(customKeys)) {
        if (style === 'accented' && !['border', 'titleBackground', 'titleForeground'].includes(key)) continue;
        for (const id of ids) colors[id] = palette[key];
    }
    return colors;
}

/** Own only selected Peek color keys, keeping a durable journal for safe restoration. */
export class PeekAppearance implements vscode.Disposable {
    private queue: Promise<void> = Promise.resolve();
    private stopped = false;
    private readonly listeners: vscode.Disposable[];

    constructor(private readonly state: vscode.Memento, private readonly output: vscode.OutputChannel) {
        this.listeners = [
            vscode.workspace.onDidChangeConfiguration(event => {
                if (event.affectsConfiguration('pythonReferenceLens.peekStyle') ||
                    event.affectsConfiguration('pythonReferenceLens.peekColors') ||
                    event.affectsConfiguration('pythonReferenceLens.enabled') ||
                    event.affectsConfiguration('workbench.colorTheme')) {
                    void this.sync();
                }
            }),
            vscode.window.onDidChangeActiveColorTheme(() => { void this.sync(); }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => { void this.sync(); })
        ];
    }

    public sync(): Promise<void> {
        if (this.stopped) return this.queue;
        this.queue = this.queue.then(() => this.synchronize(this.stopped)).catch(error => this.report(error));
        return this.queue;
    }

    public dispose(): void {
        this.stopped = true;
        this.listeners.forEach(listener => listener.dispose());
    }

    public restore(): Promise<void> {
        this.dispose();
        this.queue = this.queue.then(() => this.synchronize(true)).catch(error => this.report(error));
        return this.queue;
    }

    private report(error: unknown): void {
        this.output.appendLine(`[Peek appearance] ${String(error)}`);
        void vscode.window.showErrorMessage('Unable to update Peek appearance. See the Python Reference Lens output for details.');
    }

    private read(): Customizations | undefined {
        // Never copy merged user settings into workspace settings: removing a local
        // override should reveal the current inherited color, not a stale copy.
        return vscode.workspace.getConfiguration('workbench').inspect<Customizations>('colorCustomizations')?.workspaceValue;
    }

    private async synchronize(reset: boolean, attempt = 0): Promise<void> {
        const config = vscode.workspace.getConfiguration('pythonReferenceLens');
        const configured = config.get<string>('peekStyle', 'theme');
        const style: Style = !reset && config.get<boolean>('enabled', true) &&
            ['accented', 'contrast', 'custom'].includes(configured) ? configured as Style : 'theme';
        const saved = this.state.get<Snapshot[]>(stateKey, []);
        if (style === 'theme' && saved.length === 0) return;
        if (!vscode.workspace.workspaceFile && !vscode.workspace.workspaceFolders?.length) {
            if (style !== 'theme') throw new Error('Open a folder or workspace to customize Peek appearance.');
            return;
        }

        const original = this.read();
        const next: Customizations = { ...original };
        let hadConfiguration = original !== undefined;
        for (const snapshot of [...saved].reverse()) {
            const value = next[snapshot.themeKey];
            if (typeof value !== 'object' || value === null) continue;
            const block = { ...value };
            for (const [key, applied] of Object.entries(snapshot.applied)) {
                // Preserve a manual edit made after our last application.
                if (block[key] !== applied) continue;
                const previous = snapshot.previous[key];
                if (previous === null) delete block[key];
                else block[key] = previous;
            }
            if (Object.keys(block).length || snapshot.hadBlock) next[snapshot.themeKey] = block;
            else delete next[snapshot.themeKey];
            hadConfiguration = snapshot.hadConfiguration;
        }

        let snapshot: Snapshot | undefined;
        if (style !== 'theme') {
            const themeName = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
            if (!themeName) throw new Error('The active color theme could not be identified.');
            const themeKey = `[${themeName}]`;
            const value = next[themeKey];
            const block: Colors = typeof value === 'object' && value !== null ? { ...value } : {};
            const colors = peekColors(style, vscode.window.activeColorTheme.kind, config.get<Colors>('peekColors', {}));
            const previous: Record<string, string | null> = {};
            for (const key of Object.keys(colors)) previous[key] = block[key] ?? null;
            snapshot = { themeKey, hadBlock: value !== undefined, hadConfiguration, previous, applied: colors };
            next[themeKey] = { ...block, ...colors };
        }

        const desired = Object.keys(next).length || hadConfiguration ? next : undefined;
        const finalState = snapshot ? [snapshot] : [];
        if (JSON.stringify(original) !== JSON.stringify(desired)) {
            // Keep both old and intended values until the settings write succeeds.
            // This also recovers if the extension host exits between these writes.
            await this.state.update(stateKey, snapshot ? [...saved, snapshot] : saved);
            if (JSON.stringify(original) !== JSON.stringify(this.read())) {
                if (attempt >= 3) throw new Error('Color settings changed repeatedly; select the Peek style again to retry.');
                return this.synchronize(reset, attempt + 1);
            }
            await vscode.workspace.getConfiguration('workbench').update(
                'colorCustomizations', desired, vscode.ConfigurationTarget.Workspace
            );
        }
        await this.state.update(stateKey, finalState.length ? finalState : undefined);
    }
}
