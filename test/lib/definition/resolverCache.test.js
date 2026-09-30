'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { installMock, vscodeMock } = require('../highlight/mock-vscode');
const { check, section, summary } = require('../help/helpers');
const root = path.resolve(__dirname, '../../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-resolver-cache-'));
let folder;
const documents = [];
vscodeMock.MarkdownString = class {
    constructor() { this.value = ''; }
    appendMarkdown(text) { this.value += text; return this; }
    appendCodeblock(text) { this.value += text; return this; }
};
vscodeMock.Hover = class {
    constructor(contents, range) { this.contents = contents; this.range = range; }
};
vscodeMock.workspace = {
    getWorkspaceFolder: () => ({ uri: vscodeMock.Uri.file(folder) }),
    get textDocuments() { return documents; },
    getConfiguration: () => ({ get: () => undefined }),
    findFiles: async () => documents.map(document => document.uri),
    openTextDocument: async uri => documents.find(document => document.uri.fsPath === uri.fsPath),
};
installMock();
const parser = require('../../../out/parser/gapParser');
const { GAPDefinitionResolver } = require('../../../out/hover/definitionResolver');
const { GAPHoverProvider } = require('../../../out/hover/hoverProvider');
const { GAPDefinitionProvider } = require('../../../out/definition/definitionProvider');
const { GAPReferenceProvider } = require('../../../out/references/referenceProvider');
const { ReadChainFileCache } = require('../../../out/shared/readFileCache');
const { PARSER_MAX_DOCS } = require('../../../out/limits');
const query = path.join(root, 'queries/completion.scm');
const token = { isCancellationRequested: false };

function setup(name) {
    folder = path.join(directory, name);
    fs.mkdirSync(folder);
    documents.length = 0;
}

function document(name, initial, open = true) {
    let text = initial;
    const result = {
        uri: vscodeMock.Uri.file(path.join(folder, name)),
        version: 1, isUntitled: false, languageId: 'gap',
        getText: () => text,
        offsetAt: position => text.split('\n').slice(0, position.line)
            .reduce((length, line) => length + line.length + 1, 0) + position.character,
        replace(value) { text = value; this.version++; },
    };
    fs.writeFileSync(result.uri.fsPath, text);
    if (open) documents.push(result);
    return result;
}

function at(document, needle) {
    const text = document.getText();
    const offset = text.indexOf(needle);
    if (offset < 0) throw new Error(`Missing ${needle}`);
    const before = text.slice(0, offset);
    return new vscodeMock.Position(before.split('\n').length - 1, offset - before.lastIndexOf('\n') - 1);
}

function countCalls(object, key) {
    const original = object[key];
    let calls = 0;
    object[key] = function (...args) {
        calls++;
        return original.apply(this, args);
    };
    return { get calls() { return calls; }, restore() { object[key] = original; } };
}

function evictTrees() {
    for (let index = 0; index <= PARSER_MAX_DOCS; index++) {
        parser.getDocumentTree({
            uri: vscodeMock.Uri.file(path.join(directory, `eviction-${index}.g`)),
            version: 1, getText: () => `Eviction${index} := 0;`,
        });
    }
}

async function main() {
    await parser.initGapParser({ extensionUri: { fsPath: root } });
    section('Shared document model and parser eviction');
    setup('shared');
    const local = document('local.g', 'CacheValue := 1;\nCacheValue;\nCacheValue;\n');
    const resolver = new GAPDefinitionResolver(query);
    const events = countCalls(resolver, 'collectEvents');
    const references = new GAPReferenceProvider(query, resolver);
    const hover = new GAPHoverProvider(query, resolver);
    const definition = new GAPDefinitionProvider(query, references, resolver);
    try {
        check('shared hover resolves the variable', true,
            hover.provideHover(local, at(local, 'CacheValue;'), token).contents.value.includes('CacheValue := 1;'));
        check('shared navigation resolves the same variable', 0,
            definition.provideDefinition(local, at(local, 'CacheValue;'), token)[0].range.start.line);
        check('shared references find the remaining use', 1,
            (await references.provideReferences(local, at(local, 'CacheValue;'),
                { includeDeclaration: false }, token)).length);
        check('all three providers collect document events only once', 1, events.calls);
        evictTrees();
        check('reference occurrences survive native tree eviction', 1,
            (await references.provideReferences(local, at(local, 'CacheValue;'),
                { includeDeclaration: false }, token)).length);
        check('scalar document events survive parser eviction without recollection', 1, events.calls);
        local.replace('CacheValue := 2;\nCacheValue;\n');
        resolver.onWorkspaceFilesChanged();
        check('changed document replaces its cached definition', true,
            hover.provideHover(local, at(local, 'CacheValue;'), token).contents.value.includes('CacheValue := 2;'));
        check('changed document is collected exactly once more', 2, events.calls);
        check('changed reference index removes stale occurrences', 0,
            (await references.provideReferences(local, at(local, 'CacheValue;'),
                { includeDeclaration: false }, token)).length);
    } finally {
        events.restore();
    }

    section('Workspace index reuse and invalidation');
    setup('workspace');
    const first = document('first.g', 'First := rec(value := 1);\n');
    const second = document('second.g', 'Second := rec(value := 2);\n');
    const workspaceResolver = new GAPDefinitionResolver(query);
    const scans = countCalls(workspaceResolver, 'scanWorkspaceSymbolDefinitions');
    try {
        check('workspace lookup finds the first file', first.uri.fsPath,
            workspaceResolver.resolveWorkspaceDefinition(second, 'First').filePath);
        check('workspace lookup finds a different symbol without rescanning', second.uri.fsPath,
            workspaceResolver.resolveWorkspaceDefinition(first, 'Second').filePath);
        check('workspace is scanned once across symbol names', 1, scans.calls);
        check('current file exclusion happens per lookup, not during indexing', null,
            workspaceResolver.resolveWorkspaceDefinition(first, 'First'));
        const third = document('third.g', 'Third := 3;\n');
        workspaceResolver.onWorkspaceFilesChanged();
        check('file creation notification exposes a new symbol', third.uri.fsPath,
            workspaceResolver.resolveWorkspaceDefinition(first, 'Third').filePath);
        check('file creation triggers just one new scan', 2, scans.calls);
        second.replace('SecondRenamed := rec(value := 4);\n');
        workspaceResolver.onWorkspaceFilesChanged();
        check('unsaved edits expose the new symbol', second.uri.fsPath,
            workspaceResolver.resolveWorkspaceDefinition(first, 'SecondRenamed').filePath);
        check('unsaved edits remove the old symbol', null,
            workspaceResolver.resolveWorkspaceDefinition(first, 'Second'));
        documents.splice(documents.indexOf(second), 1);
        workspaceResolver.onDocumentClosed(second.uri);
        check('closing an unsaved document restores its disk definition', second.uri.fsPath,
            workspaceResolver.resolveWorkspaceDefinition(first, 'Second').filePath);
        fs.unlinkSync(third.uri.fsPath);
        documents.splice(documents.indexOf(third), 1);
        workspaceResolver.onWorkspaceFilesChanged();
        check('file deletion removes cached definitions', null,
            workspaceResolver.resolveWorkspaceDefinition(first, 'Third'));
        const fourth = document('fourth.g', 'Fourth := 4;\n');
        const originalNow = Date.now;
        const later = originalNow() + 6000;
        try {
            Date.now = () => later;
            check('TTL refresh finds changes without an editor notification', fourth.uri.fsPath,
                workspaceResolver.resolveWorkspaceDefinition(first, 'Fourth').filePath);
        } finally {
            Date.now = originalNow;
        }
    } finally {
        scans.restore();
    }

    section('Alias timeline cursor semantics');
    setup('aliases');
    const imported = document('imported.g', 'ME := Original;\n');
    const usage = document('use.g', [
        'ME.field;',
        'Read("imported.g");',
        'ME.field;',
        'ME := Replacement;',
        'ME.field;',
    ].join('\n'));
    const aliasResolver = new GAPDefinitionResolver(query);
    const namesAt = line => aliasResolver.resolveLookupNames(usage,
        new vscodeMock.Position(line, 0), 'ME.field');
    check('future imports do not affect an earlier cursor', ['ME.field'], namesAt(0));
    check('imported binding becomes visible at the Read', ['ME.field', 'Original.field'], namesAt(2));
    check('later reassignment replaces the imported binding', ['ME.field', 'Replacement.field'], namesAt(4));
    check('querying backwards reuses history without leaking later bindings',
        ['ME.field', 'Original.field'], namesAt(2));
    imported.replace('ME := Updated;\n');
    aliasResolver.onWorkspaceFilesChanged();
    check('unsaved imported aliases invalidate timelines', ['ME.field', 'Updated.field'], namesAt(2));

    section('File cache avoids repeated reads and parses');
    setup('files');
    const closed = document('closed.g', 'Closed := 1;\n', false);
    let parses = 0;
    const fileCache = new ReadChainFileCache((text, filePath) => {
        parses++;
        return { text, filePath };
    });
    const reads = countCalls(fs, 'readFileSync');
    try {
        fileCache.loadFile(closed.uri.fsPath);
        fileCache.loadFile(closed.uri.fsPath);
        check('unchanged disk content is read once', 1, reads.calls);
        check('unchanged disk content is parsed once', 1, parses);
        fs.writeFileSync(closed.uri.fsPath, 'Closed := 12345;\n');
        check('changed disk signature reloads content', 'Closed := 12345;\n',
            fileCache.loadFile(closed.uri.fsPath).text);
        check('disk changes cause exactly one additional read', 2, reads.calls);
        documents.push(closed);
        closed.replace('Closed := 999;\n');
        check('open unsaved content takes priority over disk', 'Closed := 999;\n',
            fileCache.loadFile(closed.uri.fsPath).text);
        check('open documents need no disk read', 2, reads.calls);
        check('parser callback receives the source path', closed.uri.fsPath,
            fileCache.loadFile(closed.uri.fsPath).filePath);
    } finally {
        reads.restore();
    }

    section('Cross-file resolution beyond the native tree cache');
    setup('many-files');
    const count = PARSER_MAX_DOCS + 2;
    for (let index = 0; index < count; index++) {
        document(`source-${index}.g`, [
            `Factory${index} := function()`,
            index + 1 === count ? '  return rec(value := 42);' : `  return Factory${index + 1}();`,
            'end;',
        ].join('\n'), false);
    }
    const many = document('use.g', 'result := Factory0();\nresult.value;\n');
    const manyResolver = new GAPDefinitionResolver(query);
    const diskReads = countCalls(fs, 'readFileSync');
    try {
        const resolved = manyResolver.resolveDefinitions(many, at(many, 'result.value'), 'result.value');
        check('recursive value tracing pins trees across workspace eviction', 1, resolved.length);
        check('recursive value tracing reaches the final producer', path.join(folder, `source-${count - 1}.g`),
            resolved[0]?.filePath);
        check('value tracing reuses file content instead of rereading each source', count, diskReads.calls);
    } finally {
        diskReads.restore();
    }
    const manyHover = new GAPHoverProvider(query, manyResolver)
        .provideHover(many, at(many, 'value;'), token);
    check('hover range remains valid after cross-file tree eviction', 1, manyHover.range.start.line);
    check('hover retains the final field definition', true,
        JSON.stringify(manyHover.contents).includes('value := 42'));
    const manyDefinition = new GAPDefinitionProvider(query, undefined, manyResolver)
        .provideDefinition(many, at(many, 'value;'), token);
    check('navigation range remains valid after cross-file tree eviction', 1,
        manyDefinition[0].range.start.line);
    const manyReferences = await new GAPReferenceProvider(query, manyResolver)
        .provideReferences(many, at(many, 'value;'), { includeDeclaration: true }, token);
    check('reference origin survives tree eviction during return tracing', 1, manyReferences.length);
    check('reference declaration points to the final producing file',
        path.join(folder, `source-${count - 1}.g`), manyReferences[0]?.uri.fsPath);
    summary();
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    parser.disposeAll();
    fs.rmSync(directory, { recursive: true, force: true });
});
