/**
 * Qualified function highlighting tests.
 */

'use strict';

const path = require('path');
const { installMock } = require('./mock-vscode');
const { check, section, summary } = require('../help/helpers');

installMock();

const { initGapParser } = require('../../../out/parser/gapParser');
const { GAPSemanticTokensProvider } = require('../../../out/semantic/semanticTokensProvider');

const ROOT = path.join(__dirname, '..', '..', '..');
const HIGHLIGHTS_PATH = path.join(ROOT, 'queries', 'highlights.scm');
const LOCALS_PATH = path.join(ROOT, 'queries', 'locals.scm');

function tokenAt(entries, line, text) {
    return entries.find(entry => entry.line === line && entry.text === text);
}

async function main() {
    await initGapParser({ extensionUri: { fsPath: ROOT } });
    const provider = new GAPSemanticTokensProvider(HIGHLIGHTS_PATH, LOCALS_PATH);
    const code = [
        'MAGNETIC_INTERNAL.CheckFiniteMatrixGroup := function(group, name)',
        '  return true;',
        'end;',
        'MAGNETIC_INTERNAL.CheckFiniteMatrixGroup(group, name);',
        'MAGNETIC_INTERNAL!.ComponentFunction := x -> x;',
        'MAGNETIC_INTERNAL!.ComponentFunction(1);',
        'container := rec(',
        '  Inline := function(value)',
        '    return value;',
        '  end,',
        '  Value := 1',
        ');',
        'container.Inline(1);',
        'container.Value;',
    ].join('\n');
    const entries = provider.queryEntries(code);

    section('Qualified function highlighting');
    check('qualified definition is a function', 'function',
        tokenAt(entries, 0, 'CheckFiniteMatrixGroup')?.type);
    check('qualified definition has declaration modifier', true,
        tokenAt(entries, 0, 'CheckFiniteMatrixGroup')?.modifiers.includes('declaration'));
    check('qualified call is a function', 'function',
        tokenAt(entries, 3, 'CheckFiniteMatrixGroup')?.type);
    check('component definition is a function', 'function',
        tokenAt(entries, 4, 'ComponentFunction')?.type);
    check('component call is a function', 'function',
        tokenAt(entries, 5, 'ComponentFunction')?.type);
    check('record-entry function is a function', 'function',
        tokenAt(entries, 7, 'Inline')?.type);
    check('record-entry function call is a function', 'function',
        tokenAt(entries, 12, 'Inline')?.type);
    check('ordinary record field remains an enum member', 'enumMember',
        tokenAt(entries, 13, 'Value')?.type);

    provider.dispose();
    summary();
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
