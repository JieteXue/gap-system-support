/** Cursor-following, read-only definition panel. */
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { GAPDefinitionResolver } from './definitionResolver';
import { GAPHoverProvider } from './hoverProvider';
import { DefinitionPreview, DefinitionPreviewService } from './definitionPreview';
import { LruCache } from '../shared/lruCache';
import { INSPECTION_LINK_MAX_ENTRIES } from '../limits';
import { tryLog, tryValue, tryValueAsync } from '../shared/guarded';
import { InspectionContext, inspectionContext } from './inspectionContext';

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
<title>GAP Info</title></head><body>
<header class="toolbar">
<span id="cursor-location"></span>
<nav aria-label="Information actions">
<button id="follow" title="Pause cursor following" aria-label="Pause cursor following" aria-pressed="false"><i class="codicon codicon-debug-pause"></i></button>
<button id="refresh" title="Refresh current position" aria-label="Refresh current position"><i class="codicon codicon-refresh"></i></button>
</nav></header>
<main id="root" aria-live="polite"><p class="state">No static definition found.</p></main>
<script nonce="${nonce}" src="${escape(resource('webresources', 'definition-lines.js'))}"></script>
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
    private info?: InspectionContext;
    private origin?: InspectionTicket;
    private following = true;
    private busy = false;
    private epoch = 0;
    private session = randomUUID();

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
        this.following = true;
        this.update(entry?.document ?? editor!.document, entry?.position ?? editor!.selection.active);
    }

    private ensurePanel(): void {
        if (this.panel) return;
        this.session = randomUUID();
        this.panel = vscode.window.createWebviewPanel(
            'gapDefinitionInspection', 'GAP Info',
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
                this.cancelTimer();
                this.epoch++;
                this.previews = [];
                this.editor = undefined;
                this.info = undefined;
                this.origin = undefined;
                this.following = true;
                this.busy = false;
                this.service.clear();
                for (const subscription of this.panelSubscriptions.splice(0)) subscription.dispose();
            }),
            vscode.window.onDidChangeTextEditorSelection(event => {
                if (event.textEditor !== vscode.window.activeTextEditor ||
                    event.textEditor.document.languageId !== 'gap') return;
                this.editor = event.textEditor;
                if (this.following) this.schedule();
            }),
            vscode.window.onDidChangeActiveTextEditor(editor => {
                // Focusing the webview is not a move to a different source file.
                if (!editor) return;
                this.editor = editor.document.languageId === 'gap' ? editor : undefined;
                if (this.following) this.schedule();
            }),
            vscode.languages.onDidChangeDiagnostics(event => {
                if (this.following && this.editor &&
                    event.uris.some(uri => uri.toString() === this.editor!.document.uri.toString())) {
                    this.schedule();
                }
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
        this.cancelTimer();
        this.epoch++;
        this.busy = true;
        this.post('loading');
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (!this.panel) return;
            tryLog(() => {
                if (this.editor) this.update(this.editor.document, this.editor.selection.active);
                else {
                    this.previews = [];
                    this.info = undefined;
                    this.origin = undefined;
                    this.busy = false;
                    this.post('empty');
                }
            }, '[GAP] Definition panel update failed');
        }, 140);
    }

    private update(document: vscode.TextDocument, position: vscode.Position): void {
        this.cancelTimer();
        this.epoch++;
        this.busy = false;
        this.origin = { document, position, text: document.getText(), revision: this.resolver.revision };
        this.info = tryValue(() => inspectionContext(document, position, this.resolver), undefined);
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
            following: this.following, busy: this.busy,
            ...(type === 'loading' ? {} : { context: this.info, previews: this.previews.map(
                ({ document: _document, sourceText: _text, revision: _revision, ...view }) => view),
            }),
        });
    }

    private receive(message: unknown): void {
        if (!message || typeof message !== 'object' || !this.panel) return;
        const input = message as Record<string, unknown>;
        if (input.type === 'ready') {
            this.post(this.busy ? 'loading' : this.previews.length ? 'definition' : 'empty');
            return;
        }
        if (input.session !== this.session || input.epoch !== this.epoch) return;
        if (input.type === 'follow' && typeof input.value === 'boolean') {
            this.following = input.value;
            this.cancelTimer();
            this.busy = false;
            if (this.following) this.refresh();
            else this.post(this.origin && !this.originFresh() ? 'stale' :
                this.previews.length ? 'definition' : 'empty');
            return;
        }
        if (input.type === 'refresh') { this.refresh(); return; }
        if (this.busy) return;
        if (input.type === 'context-source' || input.type === 'binding' || input.type === 'diagnostic') {
            if (!this.origin || !this.info || !this.originFresh()) { this.invalidate(); return; }
            let position = this.origin.position;
            if (input.type !== 'context-source') {
                if (!Number.isInteger(input.index)) return;
                const item = input.type === 'binding'
                    ? this.info.local?.bindings[input.index as number] : this.info.diagnostics[input.index as number];
                if (!item) return;
                position = new vscode.Position(item.row, item.column);
            }
            this.openSource(this.origin.document.uri, position, () => this.originFresh());
            return;
        }
        if (input.type === 'references') {
            if (!this.origin || !this.originFresh()) { this.invalidate(); return; }
            const origin = this.origin;
            const epoch = this.epoch;
            void tryValueAsync(async () => {
                const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                    'vscode.executeReferenceProvider', origin.document.uri, origin.position);
                if (this.epoch !== epoch || !this.panel || !this.originFresh()) return;
                await vscode.commands.executeCommand('editor.action.showReferences',
                    origin.document.uri, origin.position, locations ?? []);
            }, error => console.error('[GAP] Show references failed', error));
            return;
        }
        if ((input.type !== 'source' && input.type !== 'symbol') || !Number.isInteger(input.index)) return;
        const preview = this.previews[input.index as number];
        if (!preview) return;
        if (!this.service.isFresh(preview)) { this.invalidate(); return; }
        if (preview.builtin) {
            if (input.type !== 'source') return;
            void vscode.commands.executeCommand('gap.searchHelpTerm', preview.builtin);
        } else if (input.type === 'symbol' && Number.isInteger(input.token)) {
            const token = preview.tokens.find(item => item.id === input.token && item.name);
            if (!token) return;
            const epoch = this.epoch;
            const candidates = this.service.at(preview.document, new vscode.Position(token.row, token.column));
            if (!candidates.length) return;
            void tryValueAsync(async () => {
                const chosen = candidates.length === 1 ? candidates[0] :
                    (await vscode.window.showQuickPick(candidates.map(candidate => ({
                        label: candidate.title,
                        description: `${candidate.sourceLabel}:${candidate.row + 1}`,
                        candidate,
                    })), { placeHolder: 'Definition origin' }))?.candidate;
                if (!chosen || this.epoch !== epoch || !this.panel || !this.service.isFresh(chosen)) return;
                if (chosen.builtin) void vscode.commands.executeCommand('gap.searchHelpTerm', chosen.builtin);
                else this.openSource(chosen.document.uri, new vscode.Position(chosen.row, chosen.column),
                    () => this.service.isFresh(chosen));
            }, error => console.error('[GAP] Open symbol failed', error));
        } else {
            if (input.type !== 'source') return;
            this.openSource(preview.document.uri, new vscode.Position(preview.row, preview.column),
                () => this.service.isFresh(preview));
        }
    }

    private openSource(uri: vscode.Uri, position: vscode.Position, fresh: () => boolean): void {
        const epoch = this.epoch;
        const current = () => !!this.panel && this.epoch === epoch && fresh();
        void tryValueAsync(async () => {
            const document = await vscode.workspace.openTextDocument(uri);
            if (!current()) return;
            const editor = await vscode.window.showTextDocument(document, {
                viewColumn: this.editor?.viewColumn ?? vscode.ViewColumn.One,
                selection: new vscode.Range(position, position),
            });
            if (!current()) return;
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }, error => console.error('[GAP] Open information source failed', error));
    }

    private originFresh(): boolean {
        return !!this.origin && this.service.sourceFresh(
            this.origin.document, this.origin.text, this.origin.revision);
    }

    private refresh(): void {
        this.service.clear();
        if (!this.following && this.origin) {
            const source = this.origin.document.isUntitled ? this.origin.document :
                this.resolver.readSourceDocument(this.origin.document.uri.fsPath);
            if (source?.getText() === this.origin.text) {
                this.update(source, this.origin.position);
                return;
            }
        }
        if (this.editor) this.update(this.editor.document, this.editor.selection.active);
        else if (this.originFresh()) this.update(this.origin!.document, this.origin!.position);
        else {
            this.cancelTimer();
            this.previews = [];
            this.info = undefined;
            this.origin = undefined;
            this.busy = false;
            this.epoch++;
            this.post('empty');
        }
    }

    invalidate(): void {
        this.tickets.clear();
        this.service.clear();
        if (this.panel) {
            if (this.following) this.schedule();
            else {
                this.cancelTimer();
                this.epoch++;
                this.busy = false;
                this.post('stale');
            }
        }
    }

    dispose(): void {
        this.cancelTimer();
        this.panel?.dispose();
        for (const subscription of this.subscriptions) subscription.dispose();
        this.service.dispose();
        this.tickets.clear();
    }

    private cancelTimer(): void {
        clearTimeout(this.timer);
        this.timer = undefined;
    }
}
