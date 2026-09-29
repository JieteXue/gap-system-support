/**
 * Definition provider tests run under a mocked VS Code API.
 * The Read chain uses real temporary .g files.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { installMock, vscodeMock } = require('../highlight/mock-vscode');
const { check, section, summary } = require('../help/helpers');

// The provider resolves Read targets against the workspace folder.
const workspaceState = {
    folderPath: null,
    textDocuments: [],
};
vscodeMock.workspace = {
    getWorkspaceFolder: () => (
        workspaceState.folderPath ? { uri: { fsPath: workspaceState.folderPath } } : undefined
    ),
    get textDocuments() {
        return workspaceState.textDocuments;
    },
    getConfiguration: () => ({ get: () => undefined }),
};

class CancellationTokenStub {
    constructor() {
        this.isCancellationRequested = false;
    }
}

installMock();

const { initGapParser } = require('../../../out/parser/gapParser');
const { GAPDefinitionProvider } = require('../../../out/definition/definitionProvider');

const ROOT = path.join(__dirname, '..', '..', '..');
const QUERY_PATH = path.join(ROOT, 'queries', 'completion.scm');

/** A minimal TextDocument over a string. */
function makeDocument(fileName, text, workspacePath, isUntitled = false) {
    const lines = text.split(/\r?\n/);
    const uri = isUntitled
        ? { toString: () => 'untitled:Untitled-1', fsPath: '' }
        : {
            toString: () => `file:///definition-test/${fileName}`,
            fsPath: path.join(workspacePath || os.tmpdir(), fileName),
        };
    return {
        uri,
        fileName,
        version: 1,
        isUntitled,
        getText: () => text,
        languageId: 'gap',
        offsetAt: p => lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character,
        lineAt: n => lines[n] || '',
    };
}

/** Return the (line, character) of the n-th (0-based) occurrence of `needle`. */
function positionOf(text, needle, occurrence = 0) {
    let from = 0;
    for (let i = 0; i <= occurrence; i++) {
        const found = text.indexOf(needle, from);
        if (found < 0) throw new Error(`needle not found: ${needle}`);
        if (i === occurrence) {
            const before = text.slice(0, found);
            const line = before.split(/\r?\n/).length - 1;
            const character = found - (before.lastIndexOf('\n') + 1);
            return { line, character };
        }
        from = found + 1;
    }
    throw new Error('unreachable');
}

/** Return the provider location over `needle`, or undefined. */
function defineAt(provider, doc, needle, occurrence = 0) {
    const result = provider.provideDefinition(
        doc,
        positionOf(doc.getText(), needle, occurrence),
        new CancellationTokenStub(),
    );
    return Array.isArray(result) ? result[0] : result;
}

async function main() {
    await initGapParser({ extensionUri: { fsPath: ROOT } });

    const provider = new GAPDefinitionProvider(QUERY_PATH);

    section('1. Gating and same-file definitions');
    {
        const code = [
            'myfn := function(x)',
            '  return x;',
            'end;',
            'myfn(1);',
            'y := 3;',
        ].join('\n');
        const doc = makeDocument('basic.g', code, null);
        const fromCall = defineAt(provider, doc, 'myfn(1)');
        check('call callee resolves', true, fromCall !== undefined);
        const fromDef = defineAt(provider, doc, 'myfn :=');
        check('definition LHS name resolves', true, fromDef !== undefined);
        check('custom variable definitions resolve', true,
            defineAt(provider, doc, 'y :=') !== undefined);
        check('keywords stay blocked', true,
            defineAt(provider, doc, 'return') === undefined);
    }

    section('2. Location precision');
    {
        const code = [
            'square := function(x)',
            '  return x * x;',
            'end;',
            'result := square(4);',
        ].join('\n');
        const doc = makeDocument('square.g', code, null);
        const loc = defineAt(provider, doc, 'square(4)');
        check('definition row and column', '0:0', `${loc.range.start.line}:${loc.range.start.character}`);
        check('selection covers the whole name', 6, loc.range.end.character);
    }

    section('3. Indented nested definitions');
    {
        const code = [
            'outer := function()',
            '  inner := function()',
            '    return 1;',
            '  end;',
            '  return inner();',
            'end;',
            'outer();',
        ].join('\n');
        const doc = makeDocument('nested.g', code, null);
        const loc = defineAt(provider, doc, 'inner();');
        check('nested definition position', '1:2', loc && `${loc.range.start.line}:${loc.range.start.character}`);
    }

    section('4. Read chain resolution');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-definition-'));
    try {
        workspaceState.folderPath = tmp;
        fs.writeFileSync(path.join(tmp, 'lib.g'), [
            '## lib function',
            'libfn := function()',
            '  return 1;',
            'end;',
        ].join('\n'));

        const code = 'Read("lib.g");\nlibfn();\n';
        const doc = makeDocument('main.g', code, tmp);
        const loc = defineAt(provider, doc, 'libfn(');
        check('Read chain resolves to the target file', true,
            loc !== undefined && loc.uri.fsPath === path.join(tmp, 'lib.g'));

        const missing = defineAt(provider, makeDocument('main2.g', 'Read("nope.g");\nnope();\n', tmp), 'nope(');
        check('missing Read target returns undefined', true, missing === undefined);
    } finally {
        workspaceState.folderPath = null;
        fs.rmSync(tmp, { recursive: true, force: true });
    }

    section('5. Unresolvable symbols');
    {
        const doc = makeDocument('sys.g', 'size := Size(4);\n', null);
        check('system function name returns undefined', true, defineAt(provider, doc, 'Size(4)') === undefined);
    }

    section('6. Definition on its own name');
    {
        const code = [
            '## self name',
            'ownfn := function()',
            'end;',
            'ownfn();',
        ].join('\n');
        const doc = makeDocument('self.g', code, null);
        const loc = defineAt(provider, doc, 'ownfn :=');
        // The definition name resolves to its own position as a LocationLink.
        check('definition name resolves to its own LocationLink', true,
            loc !== undefined && loc.targetRange !== undefined && loc.targetSelectionRange !== undefined &&
            loc.targetRange.start.line === 1 && loc.targetRange.start.character === 0);
        // The zero-width selection point stays after the name at char 0.
        check('target selection range is zero width at the word end', '5:5',
            `${loc.targetSelectionRange.start.character}:${loc.targetSelectionRange.end.character}`);
        check('call site still returns a plain Location', true,
            defineAt(provider, doc, 'ownfn();').targetRange === undefined);
    }

    section('7. Cursor at the end of the name (right-click positions)');
    {
        const code = [
            'f := function(x)',
            '  return x;',
            'end;',
            'f();',
            'y := 3;',
        ].join('\n');
        const doc = makeDocument('wordend.g', code, null);

        // A position one past the name end still resolves.
        check('definition name at word end resolves', true, provider.provideDefinition(doc, { line: 0, character: 1 }, new CancellationTokenStub()) !== undefined);
    }

    section('8. Untitled documents');
    {
        const code = [
            'afn := function()',
            'end;',
            'afn();',
        ].join('\n');
        const doc = makeDocument('Untitled-1', code, null, true);
        const loc = defineAt(provider, doc, 'afn(');
        check('untitled document resolves against its own URI', true, loc !== undefined && loc.uri === doc.uri);
    }

    section('9. Real-world user file (IsCAPSubgroup / NonCAPSuperSolvableSubgroup)');
    {
        const code = [
            'IsCAPSubgroup := function(G, R)',
            '    local normalSubgroups, N_i, N_j, N_k, isCover, product, intersection;',
            '    normalSubgroups := NormalSubgroups(G);',
            '    for N_i in normalSubgroups do',
            '        for N_j in normalSubgroups do',
            '            if IsSubgroup(N_i, N_j) and N_j <> N_i then',
            '                isCover := true;',
            '                product := ClosureGroup(R, N_j);',
            '                intersection := Intersection(product, N_i);',
            '                if not IsNormal(G, intersection) then',
            '                    return false;',
            '                fi;',
            '            fi;',
            '        od;',
            '    od;',
            '    return true;',
            'end;',
            '',
            'NonCAPSuperSolvableSubgroup := function(G)',
            '    return IsCAPSubgroup(G, NormalSubgroups(G)[1]);',
            'end;',
            '',
            'NonCAPSuperSolvableSubgroup(G);',
        ].join('\n');
        const doc = makeDocument('real.g', code, null);

        // Definition names and call sites resolve.
        const defName = defineAt(provider, doc, 'IsCAPSubgroup :=', 0);
        check('definition name resolves', true, defName !== undefined);
        const nonCapCall = defineAt(provider, doc, 'NonCAPSuperSolvableSubgroup(G);', 0);
        check('call site resolves to the definition row', 18, nonCapCall && nonCapCall.range.start.line);

        check('unknown system identifiers stay blocked', true,
            defineAt(provider, doc, 'NormalSubgroups(G)') === undefined);
        const isCover = defineAt(provider, doc, 'isCover :=', 0);
        check('local variables resolve to their assignments', true,
            isCover !== undefined && isCover.targetRange.start.line === 6);
    }

    section('10. Definition name returns a zero-width LocationLink');
    {
        // A middle position yields a zero-width range anchored at the name start.
        const code = [
            'IsCAPSubgroup := function(G, R)',
            '  return true;',
            'end;',
            'IsCAPSubgroup(G, R);',
        ].join('\n');
        const doc = makeDocument('zero.g', code, null);
        const loc = provider.provideDefinition(doc, { line: 0, character: 6 }, new CancellationTokenStub());
        check('middle position yields a zero-width LocationLink away from the cursor', true,
            Array.isArray(loc) && loc[0].targetRange !== undefined && loc[0].targetSelectionRange !== undefined &&
            loc[0].targetSelectionRange.start.line === loc[0].targetSelectionRange.end.line &&
            loc[0].targetSelectionRange.start.character === loc[0].targetSelectionRange.end.character &&
            loc[0].targetSelectionRange.start.character === 0);
    }

    section('11. GAP declarations, implementations, and methods');
    {
        const code = [
            'DeclareGlobalFunction("declaredFn");',
            'InstallGlobalFunction(declaredFn, function(x)',
            '  return x;',
            'end);',
            'DeclareOperation("Size", [IsObject]);',
            'InstallMethod(Size, [IsList], function(x)',
            '  return Length(x);',
            'end);',
            'InstallMethod(Size, [IsGroup], function(x)',
            '  return 1;',
            'end);',
            'BindGlobal("boundFn", function() end);',
            'declaredFn(1);',
            'Size([]);',
            'boundFn();',
        ].join('\n');
        const doc = makeDocument('declarations.g', code, null);

        const declared = provider.provideDefinition(
            doc,
            positionOf(code, 'declaredFn(1);'),
            new CancellationTokenStub(),
        );
        check('global function declaration and installation return candidates', 2,
            Array.isArray(declared) ? declared.length : 0);
        check('global function implementation is first candidate', 1,
            declared ? declared[0].range.start.line : -1);

        const methods = provider.provideDefinition(
            doc,
            positionOf(code, 'Size([]);'),
            new CancellationTokenStub(),
        );
        check('operation returns declaration and all methods', 3,
            Array.isArray(methods) ? methods.length : 0);
        check('operation implementation candidates precede declaration', true,
            Boolean(methods && methods[0].range.start.line === 5 &&
                methods[1].range.start.line === 8 &&
                methods[2].range.start.line === 4));

        const bound = defineAt(provider, doc, 'boundFn();');
        check('BindGlobal string name resolves', true, bound !== undefined && bound.range.start.line === 11);

        const declarationName = defineAt(provider, doc, 'declaredFn', 0);
        check('declaration string is a valid definition position', true,
            declarationName !== undefined && declarationName.targetRange.start.line === 0);

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-declaration-'));
        try {
            fs.writeFileSync(path.join(tmp, 'decl.gd'), [
                'DeclareGlobalFunction("crossFileFn");',
                'DeclareOperation("CrossSize", [IsObject]);',
            ].join('\n'));
            fs.writeFileSync(path.join(tmp, 'impl.gi'), [
                'InstallGlobalFunction(crossFileFn, function(x) return x; end);',
                'InstallMethod(CrossSize, [IsList], function(x) return Length(x); end);',
                'InstallMethod(CrossSize, [IsGroup], function(x) return 1; end);',
            ].join('\n'));
            workspaceState.folderPath = tmp;
            const mainCode = [
                'Read("decl.gd");',
                'Read("impl.gi");',
                'crossFileFn(1);',
                'CrossSize([]);',
            ].join('\n');
            const mainDoc = makeDocument('main.g', mainCode, tmp);
            const crossFileFn = provider.provideDefinition(
                mainDoc,
                positionOf(mainCode, 'crossFileFn(1);'),
                new CancellationTokenStub(),
            );
            check('cross-file function follows gd/gi Read chain', true,
                Array.isArray(crossFileFn) &&
                crossFileFn.length === 2 &&
                crossFileFn[0].uri.fsPath === path.join(tmp, 'impl.gi'));

            const crossSize = provider.provideDefinition(
                mainDoc,
                positionOf(mainCode, 'CrossSize([]);'),
                new CancellationTokenStub(),
            );
            check('cross-file operation returns all methods and declaration', 3,
                Array.isArray(crossSize) ? crossSize.length : 0);
        } finally {
            workspaceState.folderPath = null;
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    section('12. Custom variables and lexical scope');
    {
        const code = [
            'globalValue := 1;',
            'result := globalValue;',
            'worker := function(parameter)',
            '  local localValue;',
            '  localValue := parameter;',
            '  for item in [localValue] do',
            '    result := item;',
            '  od;',
            '  return localValue;',
            'end;',
            'recordValue := rec(field := globalValue);',
            'recordValue.field;',
        ].join('\n');
        const doc = makeDocument('variables.g', code, null);

        check('global variable reference resolves', 0,
            defineAt(provider, doc, 'globalValue;', 0).range.start.line);
        check('function parameter reference resolves', 2,
            defineAt(provider, doc, 'parameter;', 0).range.start.line);
        check('local assignment resolves to the latest definition', 4,
            defineAt(provider, doc, 'localValue;', 1).range.start.line);
        check('for-loop variable reference resolves', 5,
            defineAt(provider, doc, 'item;', 0).range.start.line);
        check('record selector resolves to its record field', 10,
            defineAt(provider, doc, 'field;', 0).range.start.line);

        const nestedRecordCode = [
            'MagneticEquivalence := rec(',
            '    Matrix := rec(',
            '        Block := function(x)',
            '            return x;',
            '        end',
            '    )',
            ');',
            'MagneticEquivalence.Matrix.Block(1);',
        ].join('\n');
        const nestedRecordDoc = makeDocument('nested-record.g', nestedRecordCode, null);
        check('nested record selector resolves the outer field', 1,
            defineAt(provider, nestedRecordDoc, 'Matrix.', 0).range.start.line);
        check('nested record selector resolves the inner field', 2,
            defineAt(provider, nestedRecordDoc, 'Block(', 0).range.start.line);

        const dottedAssignmentCode = [
            'MagneticEquivalence := rec(Matrix := rec());',
            'MagneticEquivalence.Matrix.Block := function(x)',
            '    return x;',
            'end;',
            'MagneticEquivalence.Matrix.Block(1);',
        ].join('\n');
        const dottedAssignmentDoc = makeDocument('dotted-assignment.g', dottedAssignmentCode, null);
        check('dotted record assignment resolves to its definition', 1,
            defineAt(provider, dottedAssignmentDoc, 'Block(', 0).range.start.line);

        const shadowCode = [
            'value := 1;',
            'f := function(value)',
            '  return value;',
            'end;',
            'value;',
        ].join('\n');
        const shadowDoc = makeDocument('shadow.g', shadowCode, null);
        check('parameter shadows global variable', 1,
            defineAt(provider, shadowDoc, 'value;', 0).range.start.line);
        check('global variable remains visible outside the function', 0,
            defineAt(provider, shadowDoc, 'value;', 1).range.start.line);

        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-variable-'));
        try {
            fs.writeFileSync(path.join(tmp, 'values.g'), 'sharedValue := 42;\n');
            workspaceState.folderPath = tmp;
            const mainCode = 'Read("values.g");\nanswer := sharedValue;\n';
            const mainDoc = makeDocument('main.g', mainCode, tmp);
            const shared = defineAt(provider, mainDoc, 'sharedValue;');
            check('custom variable follows a Read chain', true,
                shared !== undefined && shared.uri.fsPath === path.join(tmp, 'values.g') &&
                shared.range.start.line === 0);
        } finally {
            workspaceState.folderPath = null;
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    }

    summary();
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
