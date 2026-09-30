'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { installMock, vscodeMock } = require('../highlight/mock-vscode');
const { check, section, summary } = require('../help/helpers');
const root = path.resolve(__dirname, '../../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-parameter-fields-'));
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
    getWorkspaceFolder: () => ({ uri: vscodeMock.Uri.file(directory) }),
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
const query = path.join(root, 'queries/completion.scm');
const token = { isCancellationRequested: false };

function document(name, text) {
    const lines = text.split('\n');
    const result = {
        uri: vscodeMock.Uri.file(path.join(directory, name)),
        version: 1, isUntitled: false, languageId: 'gap',
        getText: () => text,
        offsetAt: position => lines.slice(0, position.line)
            .reduce((length, line) => length + line.length + 1, 0) + position.character,
    };
    fs.writeFileSync(result.uri.fsPath, text);
    documents.push(result);
    return result;
}

function at(document, needle, shift = 0) {
    const text = document.getText();
    const offset = text.indexOf(needle) + shift;
    if (offset < shift) throw new Error(`Missing ${needle}`);
    const before = text.slice(0, offset);
    return new vscodeMock.Position(before.split('\n').length - 1, offset - before.lastIndexOf('\n') - 1);
}

async function main() {
    await parser.initGapParser({ extensionUri: { fsPath: root } });
    const library = document('library.g', [
        'Internal := rec();',
        'Public := rec();',
        'Other := rec();',
        'Internal.Make := function(group)',
        '  return rec(generators := group, nested := rec(flag := true));',
        'end;',
        'Public.Enumerate := function(group)',
        '  local characters, character;',
        '  characters := [];',
        '  character := Internal.Make(group);',
        '  Add(characters, character);',
        '  return rec(characters := characters);',
        'end;',
        'Internal.Split := function(group, character)',
        '  local generators;',
        '  generators := character.generators;',
        '  return character.nested.flag;',
        'end;',
        'Public.Split := function(group, character)',
        '  return Internal.Split(group, character);',
        'end;',
        'Public.Run := function(group)',
        '  local enumeration, character;',
        '  enumeration := Public.Enumerate(group);',
        '  character := rec(generators := "stale");',
        '  for character in enumeration.characters do',
        '    Public.Split(group, character);',
        '  od;',
        'end;',
        'Other.Split := function(group, character)',
        '  return character.generators;',
        'end;',
        'Direct := function(character)',
        '  return character.generators;',
        'end;',
        'Uncalled := function(character)',
        '  return character.generators;',
        'end;',
        'Recursive := function(character)',
        '  Recursive(character);',
        '  return character.generators;',
        'end;',
        'Shadow := function(Direct)',
        '  Direct(rec(generators := "shadowed"));',
        'end;',
        'LoopOverride := function()',
        '  local character;',
        '  for character in [rec(generators := "loop")] do',
        '    character := rec(generators := "new");',
        '    character.generators;',
        '  od;',
        'end;',
    ].join('\n'));
    const usage = document('usage.g', [
        'Read("library.g");',
        'P := Public;',
        'P.Run(G);',
        'Other.Split(G, rec(generators := "unrelated"));',
        'Direct(rec(generators := 1));',
        'Direct(rec(generators := 2));',
        'D := Direct;',
        'D(rec(generators := 3));',
        'Direct();',
        'Recursive(rec(generators := 4));',
    ].join('\n'));
    const resolver = new GAPDefinitionResolver(query);
    const resolve = (needle, name) => resolver.resolveDefinitions(library, at(library, needle), name);
    section('Parameter fields inferred from callers');
    const origins = resolve('character.generators;', 'character.generators');
    check('parameter follows wrapper callers, a for binding, and Add origins', [4],
        origins.map(definition => definition.row));
    check('same leaf on a different function does not contaminate origins', library.uri.fsPath,
        origins[0]?.filePath);
    check('nested parameter fields retain the producing record entry', [4],
        resolve('character.nested.flag', 'character.nested.flag').map(definition => definition.row));
    check('uncalled parameter does not guess a same-named record field', 0,
        resolver.resolveDefinitions(library, new vscodeMock.Position(36, 20),
            'character.generators').length);
    check('all concrete call arguments and global function aliases are alternatives', [4, 5, 7],
        resolver.resolveDefinitions(library, new vscodeMock.Position(33, 20),
            'character.generators').filter(definition => definition.filePath === usage.uri.fsPath)
            .map(definition => definition.row));
    check('local callee shadowing and missing arguments add no extra origins', 3,
        resolver.resolveDefinitions(library, new vscodeMock.Position(33, 20),
            'character.generators').length);
    check('recursive callers terminate while retaining a concrete argument', [9],
        resolver.resolveDefinitions(library, new vscodeMock.Position(40, 20),
            'character.generators').map(definition => definition.row));
    check('assignment inside a loop overrides its element binding', [48],
        resolver.resolveDefinitions(library, new vscodeMock.Position(49, 18),
            'character.generators').map(definition => definition.row));

    section('Hover, navigation, and references inside a callee');
    const position = at(library, 'character.generators;', 'character.'.length);
    const hover = new GAPHoverProvider(query, resolver).provideHover(library, position, token);
    check('parameter field hover shows the real producing definition', true,
        JSON.stringify(hover?.contents).includes('generators := group'));
    const locations = new GAPDefinitionProvider(query, undefined, resolver)
        .provideDefinition(library, position, token);
    check('parameter field navigation reaches the producer', 4, locations?.[0]?.range.start.line);
    const references = await new GAPReferenceProvider(query, resolver).provideReferences(
        library, at(library, 'generators := group'), { includeDeclaration: false }, token);
    check('producer references include the field use inside the callee', true,
        references.some(location => location.uri.fsPath === library.uri.fsPath &&
            location.range.start.line === 15));

    section('Closed sources and caller index invalidation');
    documents.splice(documents.indexOf(usage), 1);
    check('closed cross-file callers are still traced', [4, 5, 7],
        new GAPDefinitionResolver(query).resolveDefinitions(library, new vscodeMock.Position(33, 20),
            'character.generators').map(definition => definition.row));
    document('new-caller.g', 'Read("library.g");\nDirect(rec(generators := 5));\n');
    resolver.onWorkspaceFilesChanged();
    check('new caller notification invalidates the caller index', 4,
        resolver.resolveDefinitions(library, new vscodeMock.Position(33, 20),
            'character.generators').length);
    summary();
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    parser.disposeAll();
    fs.rmSync(directory, { recursive: true, force: true });
});
