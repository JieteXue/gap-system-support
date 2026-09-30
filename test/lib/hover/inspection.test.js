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
let diagnosticsChanged;
let diagnostics = [];
let openedPosition;
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
vscodeMock.languages = {
    getDiagnostics: () => diagnostics,
    onDidChangeDiagnostics(callback) { diagnosticsChanged = callback; return disposable(); },
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
        return { document, selection: undefined, revealRange(range) { openedPosition = range.start; } };
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
const { inspectionContext } = require('../../../out/hover/inspectionContext');
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
        'BindGlobal(',
        '  "MultilineInstalled", function() return counter; end);',
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
        'MultilineInstalled();',
        'Alias := Factory;',
        'Alias(true);',
    ].join('\n'));
    const resolver = new GAPDefinitionResolver(query);
    const hover = new GAPHoverProvider(query, resolver);
    const service = new DefinitionPreviewService(resolver, hover, path.join(root, 'queries/highlights.scm'));

    section('Source-mapped definition previews');
    const previews = service.at(usage, at(usage, 'Factory(true)'));
    check('full function body and delimiters are preserved', true, previews[0].text.endsWith('end;'));
    check('neighboring definition is excluded', false, previews[0].text.includes('neighbor'));
    check('original CRLF source is preserved', true, previews[0].text.includes('\r\n'));
    check('excerpt line numbering starts at the real source row', 2, previews[0].startRow);
    check('read-chain origin is the producing source file', library.uri.toString(), previews[0].uri);
    const item = symbol(previews[0], 'leaf');
    check('token uses the actual source row', 3, item.row);
    check('token offsets select exactly the displayed spelling', 'leaf',
        previews[0].text.slice(item.start, item.end));
    check('repeat preview reuses the immutable cached value', true,
        service.at(usage, at(usage, 'Factory(true)')) === previews);
    const interior = at(usage, 'Factory(true)');
    interior.character++;
    check('different cursor offsets reuse the definition highlight tokens', true,
        service.at(usage, interior)[0].tokens === previews[0].tokens);
    check('aliases reuse source tokens but retain their own titles', 'Alias',
        service.at(usage, at(usage, 'Alias(true)'))[0].title);
    check('aliases share highlight results with their actual source definition', true,
        service.at(usage, at(usage, 'Alias(true)'))[0].tokens === previews[0].tokens);
    check('nested alias segment uses its own record definition', true,
        service.at(usage, at(usage, 'Middle.Make'))[0].text.startsWith('Middle := rec'));
    check('installation preview preserves the full call', true,
        service.at(usage, at(usage, 'Installed(1)'))[0].text.endsWith('end);'));
    const multilineInstall = service.at(usage, at(usage, 'MultilineInstalled()'))[0];
    check('multiline installation preview starts before its declared name', 11, multilineInstall.startRow);
    check('multiline installation definition name retains its separate source location', 12, multilineInstall.row);
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
    section('Lexical information context');
    const lexical = document('lexical.g', [
        'Outer := function(value)',
        '  local temp, Inner;',
        '  temp := rec(field := value);',
        '  Inner := function(value)',
        '    local inner;',
        '    inner := value;',
        '    return inner + temp.field;',
        '  end;',
        '  later := 3;',
        '  return Inner;',
        'end;',
    ].join('\n'));
    const contextModel = resolver.localContext(lexical, at(lexical, 'inner + temp'));
    check('nearest named function owns the context', 'Inner', contextModel.scope);
    check('nested shadowed parameters appear once', 1,
        contextModel.bindings.filter(binding => binding.name === 'value').length);
    check('nested parameter location belongs to inner scope', 3,
        contextModel.bindings.find(binding => binding.name === 'value').row);
    check('closure includes outer local bindings', true,
        contextModel.bindings.some(binding => binding.name === 'temp'));
    check('later assignments do not leak into the current context', false,
        contextModel.bindings.some(binding => binding.name === 'later'));
    check('record fields are not lexical local variables', false,
        contextModel.bindings.some(binding => binding.name === 'field'));
    diagnostics = Array.from({ length: 250 }, (_, index) => ({
        message: `Distant ${index}`, severity: 1,
        range: new vscodeMock.Range(20 + index, 0, 20 + index, 1),
    }));
    diagnostics.push({ message: 'Current', severity: 0, range: new vscodeMock.Range(6, 0, 6, 20) });
    const boundedContext = inspectionContext(lexical, at(lexical, 'inner + temp'), resolver);
    check('file message display is bounded', 200, boundedContext.diagnostics.length);
    check('file message count includes omitted messages', 251, boundedContext.diagnosticCount);
    check('current-line messages are retained even beyond the initial limit', 'Current',
        boundedContext.diagnostics[0].message);
    diagnostics = [];
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
    panel.receive({ type: 'symbol', session: rootMessage.session, epoch: rootMessage.epoch,
        index: 0, token: symbol(rootMessage.previews[0], 'leaf').id, filePath: '/etc/passwd' });
    await new Promise(resolve => setImmediate(resolve));
    check('clickable source tokens resolve their actual source definition', 1, openedPosition.line);
    openedSource = undefined;
    panel.receive({ type: 'symbol', session: rootMessage.session, epoch: rootMessage.epoch,
        index: 0, token: 99999 });
    await new Promise(resolve => setImmediate(resolve));
    check('unissued symbol tokens cannot navigate', undefined, openedSource);
    section('Cursor following and debounce');
    const wait = () => new Promise(resolve => setTimeout(resolve, 180));
    editor.selection.active = at(usage, 'Middle.Make');
    selectionChanged({ textEditor: editor });
    selectionChanged({ textEditor: { document: library, selection: { active: at(library, 'counter :=') } } });
    editor.selection.active = at(usage, 'value;');
    selectionChanged({ textEditor: editor });
    check('cursor movement immediately retires the old preview', 'loading', panel.messages.at(-1).type);
    check('loading does not resend large preview payloads', false, 'previews' in panel.messages.at(-1));
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
    section('Pause, local actions, and diagnostic updates');
    const send = (type, extra = {}) => {
        const current = panel.messages.at(-1);
        panel.receive({ type, session: current.session, epoch: current.epoch, ...extra });
    };
    let finishOpen;
    const openTextDocument = vscodeMock.workspace.openTextDocument;
    vscodeMock.workspace.openTextDocument = () => new Promise(resolve => { finishOpen = resolve; });
    openedSource = undefined;
    send('source', { index: 0 });
    selectionChanged({ textEditor: editor });
    finishOpen(library);
    await new Promise(resolve => setImmediate(resolve));
    check('obsolete asynchronous source requests cannot open another editor', undefined, openedSource);
    vscodeMock.workspace.openTextDocument = openTextDocument;
    await wait();
    vscodeMock.workspace.openTextDocument = () => new Promise(resolve => { finishOpen = resolve; });
    send('source', { index: 0 });
    library.replace(library.getText().replace('counter := 300;', 'counter := 301;'));
    finishOpen(library);
    await new Promise(resolve => setImmediate(resolve));
    check('source edits during asynchronous loading reject old offsets', undefined, openedSource);
    library.replace(library.getText().replace('counter := 301;', 'counter := 300;'));
    vscodeMock.workspace.openTextDocument = openTextDocument;
    send('follow', { value: false });
    const paused = panel.messages.at(-1);
    editor.selection.active = at(library, 'Factory :=');
    selectionChanged({ textEditor: editor });
    await wait();
    check('pause preserves the displayed occurrence while cursor moves', paused, panel.messages.at(-1));
    send('refresh');
    check('refresh paused state retains its original occurrence', 'counter := 300;',
        panel.messages.at(-1).previews[0].text);
    send('follow', { value: true });
    check('resume resolves the latest editor cursor', 'Factory', panel.messages.at(-1).previews[0].title);
    editor.document = lexical;
    editor.selection.active = at(lexical, 'inner + temp');
    diagnostics = [
        { message: '<script>error</script>', severity: 0, source: 'gap',
            range: new vscodeMock.Range(6, 2, 7, 4) },
        { message: 'Earlier warning', severity: 1, source: 'gap',
            range: new vscodeMock.Range(0, 0, 0, 4) },
    ];
    activeChanged(editor);
    await wait();
    const withDiagnostics = panel.messages.at(-1);
    check('pane includes nearest lexical scope', 'Inner', withDiagnostics.context.local.scope);
    check('multiline diagnostics are current across their whole span', true,
        withDiagnostics.context.diagnostics[0].current);
    check('diagnostic message is plain data, not trusted markup', '<script>error</script>',
        withDiagnostics.context.diagnostics[0].message);
    const tempIndex = withDiagnostics.context.local.bindings.findIndex(item => item.name === 'temp');
    send('binding', { index: tempIndex });
    await new Promise(resolve => setImmediate(resolve));
    check('local binding clicks navigate to the latest assignment', 2, openedPosition.line);
    send('diagnostic', { index: 0 });
    await new Promise(resolve => setImmediate(resolve));
    check('diagnostic click uses the issued source location', 6, openedPosition.line);
    diagnostics = [];
    diagnosticsChanged({ uris: [lexical.uri] });
    await wait();
    check('diagnostic publication updates the pane without moving the cursor', 0,
        panel.messages.at(-1).context.diagnosticCount);
    let references;
    let finishReferences;
    commands.set('vscode.executeReferenceProvider', () =>
        new Promise(resolve => { finishReferences = resolve; }));
    commands.set('editor.action.showReferences', (...args) => { references = args; });
    send('references');
    await new Promise(resolve => setImmediate(resolve));
    selectionChanged({ textEditor: editor });
    finishReferences([]);
    await new Promise(resolve => setImmediate(resolve));
    check('obsolete asynchronous reference requests cannot open Peek', undefined, references);
    await wait();
    commands.set('vscode.executeReferenceProvider', () => []);
    send('references');
    await new Promise(resolve => setImmediate(resolve));
    check('references reuse the registered provider and native Peek', lexical.uri.toString(),
        references[0].toString());
    send('follow', { value: false });
    lexical.replace('\n' + lexical.getText());
    resolver.onWorkspaceFilesChanged();
    inspector.invalidate();
    check('paused changed sources are explicitly marked stale', 'stale', panel.messages.at(-1).type);
    openedSource = undefined;
    send('binding', { index: tempIndex });
    await new Promise(resolve => setImmediate(resolve));
    check('stale local offsets cannot navigate', undefined, openedSource);
    send('follow', { value: true });
    const html = inspectionHtml(panel.webview, context.extensionUri, 'testnonce');
    check('webview has a restrictive default CSP', true, html.includes("default-src 'none'"));
    check('webview scripts require a nonce', true, html.includes("script-src 'nonce-testnonce'"));
    check('webview does not enable arbitrary inline scripts', false, html.includes('unsafe-inline'));
    check('webview uses local stylesheet and script resources', true, html.includes('definition-inspector.js'));
    inspector.invalidate();
    const invalidatedCount = panel.messages.length;
    await commands.get('gap.inspectDefinition')(ticket);
    check('invalidated native tickets cannot reopen old source offsets', invalidatedCount, panel.messages.length);
    const oldSession = panel.messages.at(-1).session;
    panel.dispose();
    await commands.get('gap.inspectDefinition')();
    check('reopening the pane creates a new message session', true,
        panel.messages.at(-1).session !== oldSession);
    openedSource = undefined;
    panel.receive({ type: 'source', session: oldSession, epoch: panel.messages.at(-1).epoch, index: 0 });
    await new Promise(resolve => setImmediate(resolve));
    check('a closed pane session cannot navigate from the reopened pane', undefined, openedSource);
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
