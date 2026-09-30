'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { installMock, vscodeMock } = require('../highlight/mock-vscode');
const { check, section, summary } = require('../help/helpers');
const root = path.resolve(__dirname, '../../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-inspection-'));
const documents = [];
const commands = new Map();
const notifications = [];
let panel;
let openedSource;
let selectionChanged;
let activeChanged;
const disposable = () => ({ dispose() {} });
vscodeMock.MarkdownString = class {
    constructor() { this.value = ''; }
    appendMarkdown(text) { this.value += text; return this; }
    appendCodeblock(text) { this.value += text; return this; }
};
vscodeMock.Hover = class {
    constructor(contents, range) { this.contents = contents; this.range = range; }
};
vscodeMock.ViewColumn = { One: 1, Beside: 2 };
vscodeMock.TextEditorRevealType = { InCenter: 1 };
vscodeMock.Selection = class {
    constructor(start, end) { this.active = end; this.anchor = start; }
};
vscodeMock.commands = {
    registerCommand(name, callback) {
        commands.set(name, callback);
        return { dispose: () => commands.delete(name) };
    },
    executeCommand: async (name, ...args) => commands.get(name)?.(...args),
};
vscodeMock.workspace = {
    getWorkspaceFolder: () => ({ uri: vscodeMock.Uri.file(directory) }),
    get textDocuments() { return documents; },
    getConfiguration: () => ({ get: () => undefined }),
    openTextDocument: async uri => documents.find(doc => doc.uri.toString() === uri.toString()),
    createFileSystemWatcher: () => ({
        dispose() {}, onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable,
    }),
};
vscodeMock.window = {
    activeTextEditor: undefined,
    visibleTextEditors: [],
    onDidChangeTextEditorSelection(callback) { selectionChanged = callback; return disposable(); },
    onDidChangeActiveTextEditor(callback) { activeChanged = callback; return disposable(); },
    showInformationMessage: message => notifications.push(message),
    showWarningMessage: message => notifications.push(message),
    showTextDocument: async document => {
        openedSource = document;
        return { document, selection: undefined, revealRange() {} };
    },
    createWebviewPanel() {
        const result = {
            messages: [], reveal() {},
            webview: {
                cspSource: 'vscode-resource:',
                asWebviewUri: uri => uri,
                onDidReceiveMessage(callback) { result.receive = callback; return disposable(); },
                postMessage(message) { result.messages.push(message); return Promise.resolve(true); },
            },
            onDidDispose(callback) { result.closed = callback; return disposable(); },
            dispose() { result.closed?.(); },
        };
        panel = result;
        return result;
    },
};
installMock();
const parser = require('../../../out/parser/gapParser');
const { GAPDefinitionResolver } = require('../../../out/hover/definitionResolver');
const { GAPHoverProvider } = require('../../../out/hover/hoverProvider');
const { DefinitionPreviewService } = require('../../../out/hover/definitionPreview');
const { GAPDefinitionInspector, inspectionHtml } = require('../../../out/hover/definitionInspector');
const query = path.join(root, 'queries/completion.scm');
const context = { extensionUri: vscodeMock.Uri.file(root) };
const token = { isCancellationRequested: false };

function document(name, initial) {
    let text = initial;
    const result = {
        uri: vscodeMock.Uri.file(path.join(directory, name)),
        version: 1, isUntitled: false, languageId: 'gap',
        getText: () => text,
        offsetAt: position => text.split('\n').slice(0, position.line)
            .reduce((length, line) => length + line.length + 1, 0) + position.character,
        replace(value) { text = value; this.version++; },
    };
    fs.writeFileSync(result.uri.fsPath, text);
    documents.push(result);
    return result;
}

function at(document, needle) {
    const text = document.getText();
    const offset = text.indexOf(needle);
    if (offset < 0) throw new Error(`Missing ${needle}`);
    const before = text.slice(0, offset);
    return new vscodeMock.Position(before.split('\n').length - 1, offset - before.lastIndexOf('\n') - 1);
}

function symbol(preview, name) {
    return preview.tokens.find(token => token.name === name);
}

async function main() {
    await parser.initGapParser(context);
    const library = document('library.g', [
        'counter := 1;',
        'leaf := rec(value := counter);',
        'Factory := function(flag)',
        '  if flag then return rec(item := leaf); fi;',
        '  return rec(item := rec(value := 2));',
        'end;',
        'neighbor := 999;',
        'API := rec(Middle := rec(Make := Factory));',
        'BindGlobal("Installed", function(x)',
        '  return counter + x;',
        'end);',
    ].join('\r\n'));
    const usage = document('usage.g', [
        'Read("library.g");',
        'ME := API;',
        'result := Factory(true);',
        'result.item.value;',
        'ME.Middle.Make;',
        'Factory(true);',
        'Installed(1);',
        'IsBound(counter);',
    ].join('\n'));
    const resolver = new GAPDefinitionResolver(query);
    const hover = new GAPHoverProvider(query, resolver);
    const service = new DefinitionPreviewService(resolver, hover, path.join(root, 'queries/highlights.scm'));

    section('Source-mapped definition previews');
    const previews = service.at(usage, at(usage, 'Factory(true)'));
    check('full function body and delimiters are preserved', true, previews[0].text.endsWith('end;'));
    check('neighboring definition is excluded', false, previews[0].text.includes('neighbor'));
    check('original CRLF source is preserved', true, previews[0].text.includes('\r\n'));
    check('read-chain origin is the producing source file', library.uri.toString(), previews[0].uri);
    const item = symbol(previews[0], 'leaf');
    check('token uses the actual source row', 3, item.row);
    check('token offsets select exactly the displayed spelling', 'leaf',
        previews[0].text.slice(item.start, item.end));
    check('repeat preview reuses the immutable cached value', true,
        service.at(usage, at(usage, 'Factory(true)')) === previews);
    check('nested alias segment uses its own record definition', true,
        service.at(usage, at(usage, 'Middle.Make'))[0].text.startsWith('Middle := rec'));
    check('installation preview preserves the full call', true,
        service.at(usage, at(usage, 'Installed(1)'))[0].text.endsWith('end);'));
    check('builtins retain precedence and have a help action', 'IsBound',
        service.at(usage, at(usage, 'IsBound(counter)'))[0].builtin);
    check('builtin signatures also receive syntax highlighting', true,
        service.at(usage, at(usage, 'IsBound(counter)'))[0].tokens.some(token => !!token.kind));

    const choices = service.at(usage, at(usage, 'value;'));
    check('different return paths retain both source alternatives', 2, choices.length);
    check('syntax queries highlight function keywords', true,
        previews[0].tokens.some(token => token.kind === 'keyword' &&
            previews[0].text.slice(token.start, token.end) === 'function'));
    check('syntax queries highlight numeric constants', true,
        previews[0].tokens.some(token => token.kind === 'number'));

    section('Unicode, strings, and invalidation');
    const unicode = document('unicode.g', [
        'payload := "<script>unsafe</script> \u03bb \ud83d\ude00";',
        'Unicode := function(value)',
        '  return rec(value := value);',
        'end;',
        'Unicode(1);',
    ].join('\r\n'));
    resolver.onWorkspaceFilesChanged();
    const unicodeView = service.at(unicode, at(unicode, 'Unicode(1)'))[0];
    const valueTokens = unicodeView.tokens.filter(token => token.name === 'value');
    check('repeated names retain separate source offsets', 2, valueTokens.length);
    check('Unicode before a definition does not shift token source coordinates', 1, valueTokens[0].row);
    const stringView = service.at(unicode, at(unicode, 'payload :='))[0];
    check('hostile string content stays plain source text', true, stringView.text.includes('<script>'));
    check('ordinary string content is not an inspectable symbol', false,
        stringView.tokens.some(token => token.name === 'unsafe'));
    const livePreview = service.at(usage, at(usage, 'Factory(true)'))[0];
    library.replace(library.getText().replace('counter := 1;', 'counter := 200;'));
    resolver.onWorkspaceFilesChanged();
    check('edited documents invalidate source snapshots', false, service.isFresh(livePreview));
    check('refreshed preview reads the unsaved version', 'counter := 200;',
        service.at(library, at(library, 'counter :='))[0].text);

    section('Native entry links, message protocol, and CSP');
    const editor = { document: usage, selection: { active: at(usage, 'Factory(true)') }, viewColumn: 1 };
    vscodeMock.window.activeTextEditor = editor;
    const inspector = new GAPDefinitionInspector(context, resolver, query);
    await commands.get('gap.inspectDefinition')(usage.uri);
    check('editor-title resource argument opens the current editor definition', 'Factory',
        panel.messages.at(-1).previews[0].title);
    const native = inspector.hoverProvider.provideHover(usage, at(usage, 'Factory(true)'), token);
    const builtin = inspector.hoverProvider.provideHover(usage, at(usage, 'IsBound(counter)'), token);
    check('builtin native Hover also opens the definition panel', true,
        builtin.contents.value.includes('[Show definition panel]'));
    const markdown = native.contents.value;
    check('native Hover contains a panel entry', true, markdown.includes('[Show definition panel]'));
    check('trust is limited to the two explicit native commands', ['gap.goToDefinition', 'gap.inspectDefinition'],
        native.contents.isTrusted.enabledCommands);
    const link = /command:gap\.inspectDefinition\?([^)]+)/.exec(markdown);
    const ticket = JSON.parse(decodeURIComponent(link[1]))[0];
    await commands.get('gap.inspectDefinition')(ticket);
    check('native ticket opens a definition inspection panel', true, !!panel);
    const rootMessage = panel.messages.at(-1);
    check('public webview models do not leak the full source document', false,
        'sourceText' in rootMessage.previews[0]);
    check('public webview models do not leak document objects', false,
        'document' in rootMessage.previews[0]);
    const count = panel.messages.length;
    panel.receive({ type: 'source', session: rootMessage.session, epoch: rootMessage.epoch, index: 99 });
    check('unissued source candidates are rejected', count, panel.messages.length);
    panel.receive({ type: 'source', session: 'forged', epoch: rootMessage.epoch, index: 0 });
    check('cross-session messages are rejected', count, panel.messages.length);
    panel.receive({ type: 'source', session: rootMessage.session, epoch: -1, index: 0 });
    check('obsolete epochs are rejected', count, panel.messages.length);
    panel.receive({ type: 'source', session: rootMessage.session, epoch: rootMessage.epoch,
        index: 0, filePath: '/etc/passwd' });
    await new Promise(resolve => setImmediate(resolve));
    check('source navigation ignores client-supplied file paths', library.uri.toString(), openedSource.uri.toString());
    section('Cursor following and debounce');
    const wait = () => new Promise(resolve => setTimeout(resolve, 180));
    editor.selection.active = at(usage, 'Middle.Make');
    selectionChanged({ textEditor: editor });
    selectionChanged({ textEditor: { document: library, selection: { active: at(library, 'counter :=') } } });
    editor.selection.active = at(usage, 'value;');
    selectionChanged({ textEditor: editor });
    check('cursor movement immediately retires the old preview', 'loading', panel.messages.at(-1).type);
    await wait();
    check('rapid movement resolves the final cursor occurrence', 2, panel.messages.at(-1).previews.length);
    const latest = panel.messages.at(-1);
    activeChanged(undefined);
    check('focusing the panel preserves its definition', latest, panel.messages.at(-1));
    activeChanged({ document: { languageId: 'plaintext' } });
    await wait();
    check('non-GAP editors clear unrelated definitions', 'empty', panel.messages.at(-1).type);
    activeChanged(editor);
    await wait();
    library.replace(library.getText().replace('counter := 200;', 'counter := 300;'));
    resolver.onWorkspaceFilesChanged();
    editor.document = library;
    editor.selection.active = at(library, 'counter :=');
    activeChanged(editor);
    inspector.invalidate();
    await wait();
    check('unsaved edits refresh the current cursor definition', 'counter := 300;',
        panel.messages.at(-1).previews[0].text);
    const html = inspectionHtml(panel.webview, context.extensionUri, 'testnonce');
    check('webview has a restrictive default CSP', true, html.includes("default-src 'none'"));
    check('webview scripts require a nonce', true, html.includes("script-src 'nonce-testnonce'"));
    check('webview does not enable arbitrary inline scripts', false, html.includes('unsafe-inline'));
    check('webview uses local stylesheet and script resources', true, html.includes('definition-inspector.js'));
    inspector.invalidate();
    const invalidatedCount = panel.messages.length;
    await commands.get('gap.inspectDefinition')(ticket);
    check('invalidated native tickets cannot reopen old source offsets', invalidatedCount, panel.messages.length);
    inspector.dispose();
    check('disposing the inspector removes its native command', false, commands.has('gap.inspectDefinition'));
    summary();
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    parser.disposeAll();
    fs.rmSync(directory, { recursive: true, force: true });
});
