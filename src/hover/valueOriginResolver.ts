/** Trace record fields through assignments and function return values without executing GAP. */

import * as vscode from 'vscode';
import * as fs from 'fs';
import type { SyntaxNode, Tree } from 'web-tree-sitter';
import { getDocumentTree, parseGapCode } from '../parser/gapParser';
import { hasErrorAncestor } from '../shared/treeUtils';
import { symbolNameNodeAt } from '../shared/functionName';
import { definitionText } from '../shared/definitionText';
import { READ_CONTENT_LIMIT, VALUE_ORIGIN_MAX_DEPTH, VALUE_ORIGIN_MAX_STEPS } from '../limits';
import type { ResolvedDefinition } from './definitionResolver';

interface Source {
    document: vscode.TextDocument;
    tree: Tree;
    text: string;
}

interface Expression {
    node: SyntaxNode;
    context: Context;
}

interface Context {
    source: Source;
    bindings: Map<string, Expression>;
}

type FindDefinitions = (
    document: vscode.TextDocument, position: vscode.Position, name: string,
) => ResolvedDefinition[];

function isFunction(node: SyntaxNode): boolean {
    return ['function', 'atomic_function', 'lambda'].includes(node.type);
}

function scopeOf(node: SyntaxNode): SyntaxNode {
    let current = node.parent;
    while (current?.parent && !isFunction(current)) current = current.parent;
    return current ?? node;
}

function definitionValue(node: SyntaxNode): SyntaxNode | null {
    let current = node;
    while (current.parent?.type === 'record_selector' ||
        current.parent?.type === 'component_selector') current = current.parent;
    return current.parent?.childForFieldName('right') ?? null;
}

function visitScope(scope: SyntaxNode, visit: (node: SyntaxNode) => void): void {
    const walk = (node: SyntaxNode): void => {
        visit(node);
        for (const child of node.namedChildren) {
            if (!isFunction(child)) walk(child);
        }
    };
    walk(scope);
}

export function resolveValueFieldDefinitions(
    document: vscode.TextDocument,
    position: vscode.Position,
    name: string,
    findDefinitions: FindDefinitions,
): ResolvedDefinition[] {
    const parts = name.split('.');
    if (parts.length < 2 || !parts.every(part => /^[A-Za-z_][A-Za-z_0-9]*$/.test(part))) return [];
    const sources = new Map<string, Source>();
    const ownedTrees: Tree[] = [];
    const active = new Set<string>();
    let steps = 0;

    const sourceFor = (filePath: string): Source | null => {
        const key = filePath || document.uri.toString();
        const cached = sources.get(key);
        if (cached) return cached;
        const open = filePath === document.uri.fsPath || !filePath ? document :
            vscode.workspace.textDocuments.find(item => item.uri.fsPath === filePath);
        let text: string;
        try {
            if (!open && fs.statSync(filePath).size > READ_CONTENT_LIMIT) return null;
            text = open ? open.getText() : fs.readFileSync(filePath, 'utf8');
        } catch {
            return null;
        }
        if (text.length > READ_CONTENT_LIMIT) return null;
        const tree = open ? getDocumentTree(open, text) : parseGapCode(text);
        if (!open) ownedTrees.push(tree);
        const lines = text.split(/\r?\n/);
        const sourceDocument = open ?? {
            uri: vscode.Uri.file(filePath),
            version: 1,
            isUntitled: false,
            getText: () => text,
            offsetAt: (p: vscode.Position) =>
                lines.slice(0, p.line).reduce((sum, line) => sum + line.length + 1, 0) + p.character,
        } as vscode.TextDocument;
        const source = { document: sourceDocument, tree, text };
        sources.set(key, source);
        return source;
    };

    const fieldDefinition = (node: SyntaxNode, context: Context): ResolvedDefinition => {
        const lines = context.source.text.split(/\r?\n/);
        const row = node.startPosition.row;
        const commentLines: string[] = [];
        for (let index = row - 1; index >= 0 && lines[index].trimStart().startsWith('##'); index--) {
            commentLines.unshift(lines[index].trimStart().replace(/^#+ ?/, ''));
        }
        return {
            definitionLine: lines[row].trim(),
            definitionText: definitionText(node),
            commentLines,
            filePath: context.source.document.isUntitled ? '' : context.source.document.uri.fsPath,
            row,
            column: node.startPosition.column,
            symbolKind: 'variable',
        };
    };

    const trace = (expression: Expression, fields: string[], depth = 0): ResolvedDefinition[] => {
        if (fields.length === 0 || depth > VALUE_ORIGIN_MAX_DEPTH ||
            ++steps > VALUE_ORIGIN_MAX_STEPS) return [];
        const { node, context } = expression;
        if (hasErrorAncestor(node)) return [];
        const bindingKey = [...context.bindings.values()].map(value =>
            `${value.context.source.document.uri.toString()}:${value.node.startIndex}`).join(',');
        const key = `${context.source.document.uri.toString()}:${node.startIndex}:${fields.join('.')}:${bindingKey}`;
        if (active.has(key)) return [];
        active.add(key);
        const follow = (value: SyntaxNode | null | undefined, rest = fields, ctx = context) =>
            value ? trace({ node: value, context: ctx }, rest, depth + 1) : [];
        try {
            if (node.type === 'record_expression') {
                const entries = node.namedChildren.filter(entry =>
                    entry.type === 'record_entry' && entry.childForFieldName('left')?.text === fields[0]);
                return entries.flatMap(entry => fields.length === 1
                    ? [fieldDefinition(entry.childForFieldName('left')!, context)]
                    : follow(entry.childForFieldName('right'), fields.slice(1)));
            }
            if (node.type === 'record_selector') {
                const selector = node.childForFieldName('selector');
                return selector?.type === 'identifier'
                    ? follow(node.childForFieldName('variable'), [selector.text, ...fields]) : [];
            }
            if (node.type === 'list_selector') {
                return follow(node.childForFieldName('variable'), ['[]', ...fields]);
            }
            if (node.type === 'list_expression' && fields[0] === '[]') {
                return node.namedChildren.flatMap(child => follow(child, fields.slice(1)));
            }
            if (node.type === 'identifier') {
                const scope = scopeOf(node);
                const assignments: SyntaxNode[] = [];
                const updates: SyntaxNode[] = [];
                const additions: SyntaxNode[] = [];
                visitScope(scope, candidate => {
                    if (candidate.endIndex >= node.startIndex) return;
                    if (candidate.type === 'assignment_statement') {
                        const left = candidate.childForFieldName('left');
                        if (left?.text === node.text) assignments.push(candidate);
                        if (left?.text === `${node.text}.${fields[0]}`) updates.push(candidate);
                    }
                    if (fields[0] === '[]' && candidate.type === 'call' &&
                        candidate.childForFieldName('function')?.text === 'Add' &&
                        candidate.childForFieldName('arguments')?.namedChildren[0]?.text === node.text) {
                        additions.push(candidate);
                    }
                });
                const update = updates.at(-1);
                if (update) {
                    const left = update.childForFieldName('left')!;
                    return fields.length === 1
                        ? [fieldDefinition(left.childForFieldName('selector')!, context)]
                        : follow(update.childForFieldName('right'), fields.slice(1));
                }
                if (additions.length > 0) {
                    return additions.flatMap(call =>
                        follow(call.childForFieldName('arguments')?.namedChildren[1], fields.slice(1)));
                }
                const assignment = assignments.at(-1);
                if (assignment) return follow(assignment.childForFieldName('right'));
                const binding = context.bindings.get(node.text);
                if (binding) return trace(binding, fields, depth + 1);
                const locallyDeclared = isFunction(scope) &&
                    [scope.childForFieldName('parameters'), scope.childForFieldName('locals')]
                        .some(declaration => declaration?.namedChildren.some(child => child.text === node.text));
                if (locallyDeclared) return [];
                return findDefinitions(context.source.document,
                    new vscode.Position(node.startPosition.row, node.startPosition.column), node.text)
                    .flatMap(definition => {
                        const source = sourceFor(definition.filePath);
                        if (!source) return [];
                        const target = source.tree.rootNode.descendantForIndex(source.document.offsetAt(
                            new vscode.Position(definition.row, definition.column)));
                        return follow(definitionValue(target), fields,
                            { source, bindings: new Map() });
                    });
            }
            if (node.type === 'call') {
                const callee = node.childForFieldName('function');
                if (!callee || !['identifier', 'record_selector'].includes(callee.type)) return [];
                const args = node.childForFieldName('arguments')?.namedChildren ?? [];
                return findDefinitions(context.source.document,
                    new vscode.Position(callee.startPosition.row, callee.startPosition.column), callee.text)
                    .flatMap(definition => {
                        const source = sourceFor(definition.filePath);
                        if (!source) return [];
                        const target = source.tree.rootNode.descendantForIndex(source.document.offsetAt(
                            new vscode.Position(definition.row, definition.column)));
                        const fn = definitionValue(target);
                        if (!fn || !isFunction(fn)) return [];
                        const bindings = new Map<string, Expression>();
                        fn.childForFieldName('parameters')?.namedChildren.forEach((parameter, index) => {
                            if (args[index]) bindings.set(parameter.text, { node: args[index], context });
                        });
                        const result: ResolvedDefinition[] = [];
                        visitScope(fn, candidate => {
                            if (candidate.type === 'return_statement') {
                                result.push(...follow(candidate.namedChildren[0], fields, { source, bindings }));
                            }
                        });
                        return result;
                    });
            }
            return [];
        } finally {
            active.delete(key);
        }
    };

    try {
        const source = sourceFor(document.isUntitled ? '' : document.uri.fsPath);
        if (!source) return [];
        const atCursor = symbolNameNodeAt(source.tree.rootNode, document.offsetAt(position)) ??
            source.tree.rootNode.descendantForIndex(document.offsetAt(position));
        let expression = atCursor;
        while (expression.parent?.type === 'record_selector') expression = expression.parent;
        while (expression.type === 'record_selector') {
            expression = expression.childForFieldName('variable')!;
        }
        if (expression.type !== 'identifier' || expression.text !== parts[0]) return [];
        const definitions = trace({ node: expression, context: { source, bindings: new Map() } }, parts.slice(1));
        const seen = new Set<string>();
        return definitions.filter(definition => {
            const key = `${definition.filePath}:${definition.row}:${definition.column}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    } finally {
        for (const tree of ownedTrees) tree.delete();
    }
}
