/** Cursor-following, read-only definition panel. */
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { GAPDefinitionResolver } from './definitionResolver';
import { GAPHoverProvider } from './hoverProvider';
import { DefinitionPreview, DefinitionPreviewService } from './definitionPreview';
import { LruCache } from '../shared/lruCache';
import { INSPECTION_LINK_MAX_ENTRIES } from '../limits';
import { tryLog, tryValue, tryValueAsync } from '../shared/guarded';

export function inspectionHtml(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
    const resource = (...parts: string[]) =>
        webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...parts)).toString();
    const escape = (text: string) => text.replace(/[&<>"']/g, char =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
    return `<!doctype html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${escape(webview.cspSource)}; font-src ${escape(webview.cspSource)}; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${escape(resource('node_modules', '@vscode', 'codicons', 'dist', 'codicon.css'))}">
<link rel="stylesheet" href="${escape(resource('webresources', 'definition-inspector.css'))}">
<title>GAP Definition</title></head><body>
<main id="root" aria-live="polite"><p class="state">No static definition found.</p></main>
<script nonce="${nonce}" src="${escape(resource('webresources', 'definition-inspector.js'))}"></script>
</body></html>`;
}

interface InspectionTicket {
    document: vscode.TextDocument;
    position: vscode.Position;
    text: string;
    revision: number;
}

export class GAPDefinitionInspector implements vscode.Disposable {
    readonly hoverProvider: GAPHoverProvider;
    private readonly service: DefinitionPreviewService;
    private readonly tickets = new LruCache<string, InspectionTicket>({ maxEntries: INSPECTION_LINK_MAX_ENTRIES });
    private readonly subscriptions: vscode.Disposable[];
    private panelSubscriptions: vscode.Disposable[] = [];
    private panel?: vscode.WebviewPanel;
    private timer?: ReturnType<typeof setTimeout>;
    private editor?: vscode.TextEditor;
    private previews: DefinitionPreview[] = [];
    private epoch = 0;
    private readonly session = randomUUID();

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly resolver: GAPDefinitionResolver,
        completionPath: string,
    ) {
        this.hoverProvider = new GAPHoverProvider(completionPath, resolver, (document, position) => {
            const ticket = randomUUID();
            this.tickets.set(ticket, { document, position, text: document.getText(), revision: resolver.revision });
            return `[Show definition panel](command:gap.inspectDefinition?${encodeURIComponent(JSON.stringify([ticket]))})`;
        });
        this.service = new DefinitionPreviewService(resolver, this.hoverProvider,
            vscode.Uri.joinPath(context.extensionUri, 'queries', 'highlights.scm').fsPath);
        this.subscriptions = [
            vscode.commands.registerCommand('gap.inspectDefinition', (ticket?: unknown) =>
                tryValueAsync(() => this.open(ticket), error => {
                    console.error('[GAP] Definition panel failed', error);
                    void vscode.window.showWarningMessage('The definition could not be displayed.');
                })),
        ];
    }

    private async open(ticket?: unknown): Promise<void> {
        // Editor-title menus pass a resource URI; only strings are Hover tickets.
        const entry = typeof ticket === 'string' ? this.tickets.peek(ticket) : undefined;
        if (typeof ticket === 'string' && !entry) return;
        if (entry && !this.service.sourceFresh(entry.document, entry.text, entry.revision)) return;
        const editor = vscode.window.activeTextEditor;
        if (!entry && editor?.document.languageId !== 'gap') return;
        this.editor = editor?.document.languageId === 'gap' ? editor : this.editor;
        this.ensurePanel();
        this.panel!.reveal(vscode.ViewColumn.Beside, true);
        this.update(entry?.document ?? editor!.document, entry?.position ?? editor!.selection.active);
    }

    private ensurePanel(): void {
        if (this.panel) return;
        this.panel = vscode.window.createWebviewPanel(
            'gapDefinitionInspection', 'GAP Definition',
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
            { enableScripts: true, localResourceRoots: [
                vscode.Uri.joinPath(this.context.extensionUri, 'webresources'),
                vscode.Uri.joinPath(this.context.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
            ] },
        );
        this.panel.webview.html = inspectionHtml(this.panel.webview, this.context.extensionUri,
            randomUUID().replace(/-/g, ''));
        this.panelSubscriptions.push(
            this.panel.webview.onDidReceiveMessage(message =>
                tryLog(() => this.receive(message), '[GAP] Invalid definition panel message')),
            this.panel.onDidDispose(() => {
                this.panel = undefined;
                clearTimeout(this.timer);
                this.previews = [];
                this.editor = undefined;
                this.service.clear();
                for (const subscription of this.panelSubscriptions.splice(0)) subscription.dispose();
            }),
            vscode.window.onDidChangeTextEditorSelection(event => {
                if (event.textEditor !== vscode.window.activeTextEditor ||
                    event.textEditor.document.languageId !== 'gap') return;
                this.editor = event.textEditor;
                this.schedule();
            }),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                // Focusing the webview is not a move to a different source file.
                if (!editor) return;
                this.editor = editor.document.languageId === 'gap' ? editor : undefined;
                this.schedule();
            }),
        );
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.{g,gd,gi,gap}');
        const changed = () => {
            this.resolver.onWorkspaceFilesChanged();
            this.invalidate();
        };
        this.panelSubscriptions.push(watcher, watcher.onDidChange(changed),
            watcher.onDidCreate(changed), watcher.onDidDelete(changed));
    }

    private schedule(): void {
        clearTimeout(this.timer);
        this.previews = [];
        this.epoch++;
        this.post('loading');
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (!this.panel) return;
            tryLog(() => {
                if (this.editor) this.update(this.editor.document, this.editor.selection.active);
                else this.post('empty');
            }, '[GAP] Definition panel update failed');
        }, 140);
    }

    private update(document: vscode.TextDocument, position: vscode.Position): void {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.epoch++;
        this.previews = tryValue(() => this.service.at(document, position), error => {
            console.error('[GAP] Definition panel resolution failed', error);
            return [];
        });
        this.post(this.previews.length ? 'definition' : 'empty');
    }

    private post(type: string): void {
        if (!this.panel) return;
        void this.panel.webview.postMessage({
            type, session: this.session, epoch: this.epoch,
            previews: type === 'definition' ? this.previews.map(
                ({ document: _document, sourceText: _text, revision: _revision, ...view }) => view) : [],
        });
    }

    private receive(message: unknown): void {
        if (!message || typeof message !== 'object' || !this.panel) return;
        const input = message as Record<string, unknown>;
        if (input.type === 'ready') {
            this.post(this.timer ? 'loading' : this.previews.length ? 'definition' : 'empty');
            return;
        }
        if (input.session !== this.session || input.epoch !== this.epoch ||
            input.type !== 'source' || !Number.isInteger(input.index)) return;
        const preview = this.previews[input.index as number];
        if (!preview) return;
        if (!this.service.isFresh(preview)) { this.invalidate(); return; }
        if (preview.builtin) {
            void vscode.commands.executeCommand('gap.searchHelpTerm', preview.builtin);
        } else {
            void tryValueAsync(async () => {
                const document = await vscode.workspace.openTextDocument(preview.document.uri);
                const editor = await vscode.window.showTextDocument(document, {
                    viewColumn: this.editor?.viewColumn ?? vscode.ViewColumn.One,
                });
                const position = new vscode.Position(preview.row, preview.column);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            }, error => console.error('[GAP] Open definition source failed', error));
        }
    }

    invalidate(): void {
        this.tickets.clear();
        this.service.clear();
        if (this.panel) this.schedule();
    }

    dispose(): void {
        clearTimeout(this.timer);
        this.panel?.dispose();
        for (const subscription of this.subscriptions) subscription.dispose();
        this.service.dispose();
        this.tickets.clear();
    }
}
