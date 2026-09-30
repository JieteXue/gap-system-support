/** Trace record fields through assignments and function return values without executing GAP. */

import * as vscode from 'vscode';
import type { SyntaxNode, Tree } from 'web-tree-sitter';
import { hasErrorAncestor } from '../shared/treeUtils';
import { symbolNameNodeAt } from '../shared/functionName';
import { definitionText } from '../shared/definitionText';
import { VALUE_ORIGIN_MAX_DEPTH, VALUE_ORIGIN_MAX_STEPS } from '../limits';
import type { ResolvedDefinition } from './definitionResolver';

export interface ValueSource {
    document: vscode.TextDocument;
    tree: Tree;
    lines: string[];
    offsetAt: (position: vscode.Position) => number;
}

interface ScopeIndex {
    assignments: Map<string, SyntaxNode[]>;
    additions: Map<string, SyntaxNode[]>;
    returns: SyntaxNode[];
    locals: Set<string>;
}

interface Source extends ValueSource {
    scopes: Map<number, ScopeIndex>;
    records: Map<number, Map<string, SyntaxNode[]>>;
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

function appendNode(index: Map<string, SyntaxNode[]>, name: string, node: SyntaxNode): void {
    const bucket = index.get(name);
    if (bucket) bucket.push(node);
    else index.set(name, [node]);
}

/** Nodes are collected in source order; only completed statements are visible. */
function precedingCount(nodes: SyntaxNode[], offset: number): number {
    let low = 0;
    let high = nodes.length;
    while (low < high) {
        const middle = (low + high) >>> 1;
        if (nodes[middle].endIndex < offset) low = middle + 1;
        else high = middle;
    }
    return low;
}

export function resolveValueFieldDefinitions(
    document: vscode.TextDocument,
    position: vscode.Position,
    name: string,
    findDefinitions: FindDefinitions,
    loadSource: (filePath: string) => ValueSource | null,
): ResolvedDefinition[] {
    const parts = name.split('.');
    if (parts.length < 2 || !parts.every(part => /^[A-Za-z_][A-Za-z_0-9]*$/.test(part))) return [];
    const sources = new Map<string, Source>();
    const ownedTrees: Tree[] = [];
    const active = new Set<string>();
    const definitionCache = new Map<string, ResolvedDefinition[]>();
    let steps = 0;

    const sourceFor = (filePath: string): Source | null => {
        const key = filePath || document.uri.toString();
        const cached = sources.get(key);
        if (cached) return cached;
        const loaded = loadSource(filePath);
        if (!loaded) return null;
        // A cheap tree copy pins native nodes while nested lookups evict parser entries.
        const tree = loaded.tree.copy();
        ownedTrees.push(tree);
        const source: Source = { ...loaded, tree, scopes: new Map(), records: new Map() };
        sources.set(key, source);
        return source;
    };

    const definitionsFor = (source: Source, node: SyntaxNode, lookupName: string): ResolvedDefinition[] => {
        const key = `${source.document.uri.toString()}:${node.startIndex}:${lookupName}`;
        const cached = definitionCache.get(key);
        if (cached) return cached;
        const definitions = findDefinitions(source.document,
            new vscode.Position(node.startPosition.row, node.startPosition.column), lookupName);
        definitionCache.set(key, definitions);
        return definitions;
    };

    const scopeIndex = (source: Source, scope: SyntaxNode): ScopeIndex => {
        const cached = source.scopes.get(scope.startIndex);
        if (cached) return cached;
        const index: ScopeIndex = {
            assignments: new Map(), additions: new Map(), returns: [], locals: new Set(),
        };
        for (const declaration of [scope.childForFieldName('parameters'), scope.childForFieldName('locals')]) {
            for (const child of declaration?.namedChildren ?? []) index.locals.add(child.text);
        }
        visitScope(scope, node => {
            if (node.type === 'assignment_statement') {
                const left = node.childForFieldName('left');
                if (left) appendNode(index.assignments, left.text, node);
            } else if (node.type === 'return_statement') {
                const value = node.namedChildren[0];
                if (value) index.returns.push(value);
            } else if (node.type === 'call' && node.childForFieldName('function')?.text === 'Add') {
                const list = node.childForFieldName('arguments')?.namedChildren[0];
                if (list) appendNode(index.additions, list.text, node);
            }
        });
        source.scopes.set(scope.startIndex, index);
        return index;
    };

    const fieldDefinition = (node: SyntaxNode, context: Context): ResolvedDefinition => {
        const lines = context.source.lines;
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
                let record = context.source.records.get(node.startIndex);
                if (!record) {
                    record = new Map();
                    for (const entry of node.namedChildren) {
                        const left = entry.type === 'record_entry' ? entry.childForFieldName('left') : null;
                        if (left) appendNode(record, left.text, entry);
                    }
                    context.source.records.set(node.startIndex, record);
                }
                const entries = record.get(fields[0]) ?? [];
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
                const index = scopeIndex(context.source, scope);
                const assignments = index.assignments.get(node.text) ?? [];
                const updates = index.assignments.get(`${node.text}.${fields[0]}`) ?? [];
                const additions = fields[0] === '[]' ? index.additions.get(node.text) ?? [] : [];
                const update = updates[precedingCount(updates, node.startIndex) - 1];
                if (update) {
                    const left = update.childForFieldName('left')!;
                    return fields.length === 1
                        ? [fieldDefinition(left.childForFieldName('selector')!, context)]
                        : follow(update.childForFieldName('right'), fields.slice(1));
                }
                const additionCount = precedingCount(additions, node.startIndex);
                if (additionCount > 0) {
                    return additions.slice(0, additionCount).flatMap(call =>
                        follow(call.childForFieldName('arguments')?.namedChildren[1], fields.slice(1)));
                }
                const assignment = assignments[precedingCount(assignments, node.startIndex) - 1];
                if (assignment) return follow(assignment.childForFieldName('right'));
                const binding = context.bindings.get(node.text);
                if (binding) return trace(binding, fields, depth + 1);
                if (isFunction(scope) && index.locals.has(node.text)) return [];
                return definitionsFor(context.source, node, node.text)
                    .flatMap(definition => {
                        const source = sourceFor(definition.filePath);
                        if (!source) return [];
                        const target = source.tree.rootNode.descendantForIndex(source.offsetAt(
                            new vscode.Position(definition.row, definition.column)));
                        return follow(definitionValue(target), fields,
                            { source, bindings: new Map() });
                    });
            }
            if (node.type === 'call') {
                const callee = node.childForFieldName('function');
                if (!callee || !['identifier', 'record_selector'].includes(callee.type)) return [];
                const args = node.childForFieldName('arguments')?.namedChildren ?? [];
                return definitionsFor(context.source, callee, callee.text)
                    .flatMap(definition => {
                        const source = sourceFor(definition.filePath);
                        if (!source) return [];
                        const target = source.tree.rootNode.descendantForIndex(source.offsetAt(
                            new vscode.Position(definition.row, definition.column)));
                        const fn = definitionValue(target);
                        if (!fn || !isFunction(fn)) return [];
                        const bindings = new Map<string, Expression>();
                        fn.childForFieldName('parameters')?.namedChildren.forEach((parameter, index) => {
                            if (args[index]) bindings.set(parameter.text, { node: args[index], context });
                        });
                        return scopeIndex(source, fn).returns.flatMap(value =>
                            follow(value, fields, { source, bindings }));
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
