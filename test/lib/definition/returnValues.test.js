'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { installMock, vscodeMock } = require('../highlight/mock-vscode');
const { check, section, summary } = require('../help/helpers');
const root = path.resolve(__dirname, '../../..');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-return-values-'));
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
const { initGapParser } = require('../../../out/parser/gapParser');
const { GAPDefinitionResolver } = require('../../../out/hover/definitionResolver');
const { GAPHoverProvider } = require('../../../out/hover/hoverProvider');
const { GAPDefinitionProvider } = require('../../../out/definition/definitionProvider');
const { GAPReferenceProvider } = require('../../../out/references/referenceProvider');
const query = path.join(root, 'queries/completion.scm');
const token = { isCancellationRequested: false };

function document(name, text) {
    const lines = text.split('\n');
    const uri = vscodeMock.Uri.file(path.join(directory, name));
    const result = {
        uri, version: 1, isUntitled: false, languageId: 'gap',
        getText: () => text,
        offsetAt: position => lines.slice(0, position.line)
            .reduce((length, line) => length + line.length + 1, 0) + position.character,
    };
    fs.writeFileSync(uri.fsPath, text);
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

async function main() {
    await initGapParser({ extensionUri: { fsPath: root } });
    const library = document('library.g', [
        'Library := rec(Compare := rec());',
        'Library.MakeRepresentation := function(group)',
        '  return rec(group := group, spatialGroup := group);',
        'end;',
        'Library.Split := function(group)',
        '  local representation;',
        '  representation := Library.MakeRepresentation(group);',
        '  return rec(representation := representation);',
        'end;',
        'Library.Enumerate := function(group)',
        '  local splits, candidate;',
        '  splits := [];',
        '  candidate := Library.Split(group);',
        '  Add(splits, candidate);',
        '  return rec(splits := splits);',
        'end;',
        'Library.Compare.IntegralTimeAxes := function(group1, group2)',
        '  local axes, block1, rep2;',
        '  if group1 = fail then return rec(equivalent := false); fi;',
        '  axes := Library.Enumerate(group1);',
        '  block1 := axes.splits[1];',
        '  rep2 := Library.MakeRepresentation(group2);',
        '  return rec(equivalent := true, fullConjugator := group1,',
        '    spatialConjugator := group2, representation1 := block1.representation,',
        '    representation2 := rep2);',
        'end;',
        'Forward := function(x, y) return Library.Compare.IntegralTimeAxes(x, y); end;',
        'Identity := function(value) return value; end;',
        'Recursive := function() return Recursive(); end;',
    ].join('\n'));
    const usage = document('usage.g', [
        'Read("library.g");',
        'ME := Library;',
        'result := ME.Compare.IntegralTimeAxes(G, H);',
        'result.equivalent;',
        'result.fullConjugator;',
        'result.spatialConjugator;',
        'result.representation1.spatialGroup;',
        'result.representation2.group;',
        'forwarded := Forward(G, H);',
        'forwarded.fullConjugator;',
        'copy := Identity(result);',
        'copy.representation2.spatialGroup;',
        'unknown := Unknown();',
        'unknown.equivalent;',
        'recursive := Recursive();',
        'recursive.equivalent;',
        'result := 1;',
        'result.fullConjugator;',
        'nestedCopy := Identity(Identity(ME.Compare.IntegralTimeAxes(G, H)));',
        'nestedCopy.fullConjugator;',
    ].join('\n'));
    const resolver = new GAPDefinitionResolver(query);
    const resolve = name => resolver.resolveDefinitions(usage, at(usage, name), name);
    section('Return record field origins');
    check('all return branches preserve equivalent field origins', 2,
        resolve('result.equivalent').length);
    check('direct result field resolves to its return record', 22,
        resolve('result.fullConjugator')[0]?.row);
    check('nested field follows list insertion, indexing, and wrapper calls', 2,
        resolve('result.representation1.spatialGroup')[0]?.row);
    check('nested field follows a local function result', 2,
        resolve('result.representation2.group')[0]?.row);
    check('forwarded returns preserve field origins', 22,
        resolve('forwarded.fullConjugator')[0]?.row);
    check('parameter forwarding preserves nested field origins', 2,
        resolve('copy.representation2.spatialGroup')[0]?.row);
    check('unknown returns do not guess same-named fields', 0,
        resolve('unknown.equivalent').length);
    check('recursive returns terminate without a guessed origin', 0,
        resolve('recursive.equivalent').length);
    check('reassignment invalidates the previous record result', 0,
        resolver.resolveDefinitions(usage, new vscodeMock.Position(17, 8), 'result.fullConjugator').length);
    check('nested calls to the same forwarding function keep argument contexts', 22,
        resolve('nestedCopy.fullConjugator')[0]?.row);
    const endPosition = at(usage, 'result.fullConjugator');
    endPosition.character += 'result.fullConjugator'.length;
    check('field lookup works at the end of the identifier', 22,
        resolver.resolveDefinitions(usage, endPosition, 'result.fullConjugator')[0]?.row);
    documents.splice(documents.indexOf(library), 1);
    check('unopened cross-file function results still resolve', 2,
        new GAPDefinitionResolver(query).resolveDefinitions(usage,
            at(usage, 'result.representation1.spatialGroup'), 'result.representation1.spatialGroup')[0]?.row);
    documents.unshift(library);

    section('Hover, navigation, and reverse references');
    const hover = new GAPHoverProvider(query);
    const information = hover.provideHover(usage, at(usage, 'fullConjugator;'), token);
    check('hover shows the returned record field', true,
        JSON.stringify(information?.contents).includes('fullConjugator := group1'));
    check('returned field hover excludes adjacent record entries', false,
        JSON.stringify(information?.contents).includes('equivalent := true'));
    const definitions = new GAPDefinitionProvider(query).provideDefinition(
        usage, at(usage, 'fullConjugator;'), token);
    check('native navigation reaches the producing file', library.uri.fsPath,
        definitions?.[0]?.uri.fsPath);
    const references = await new GAPReferenceProvider(query).provideReferences(
        library, at(library, 'fullConjugator :='), { includeDeclaration: false }, token);
    check('return field finds the original and forwarded result usages', [4, 9, 19],
        references.filter(location => location.uri.fsPath === usage.uri.fsPath)
            .map(location => location.range.start.line));
    summary();
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
