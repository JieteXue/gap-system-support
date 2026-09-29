/** Shared gating for function and GAP symbol names. */

import type { SyntaxNode } from 'web-tree-sitter';

const DECLARATION_CALLS = new Set([
    'DeclareGlobalFunction',
    'DeclareOperation',
    'DeclareAttribute',
    'DeclareProperty',
    'DeclareCategory',
    'DeclareRepresentation',
]);

const IMPLEMENTATION_CALLS = new Set([
    'InstallGlobalFunction',
    'InstallMethod',
    'BindGlobal',
]);

const STRING_NAME_CALLS = new Set([
    ...DECLARATION_CALLS,
    'BindGlobal',
]);

/**
 * Return the name node when the cursor is on a function or GAP symbol name.
 * Positions on a call callee, function definition LHS, or declaration/
 * installation name qualify.
 * All other positions, such as variables, parameters, or keywords, return null.
 */
export function functionNameNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    const node = identifierNodeAt(root, offset);
    if (!node) return null;

    const parent = node.parent;
    if (!parent) return null;

    if (parent.type === 'assignment_statement') {
        // Match the left child against the node by id.
        const left = parent.childForFieldName('left');
        if (left && left.id === node.id) {
            const right = parent.childForFieldName('right');
            if (right && (right.type === 'function'
                || right.type === 'atomic_function'
                || right.type === 'lambda')) {
                return node;
            }
        }
    }

    if (parent.type === 'call') {
        const callee = parent.childForFieldName('function');
        // Every call callee names a function.
        if (callee && callee.id === node.id) {
            return node;
        }
    }

    if (parent.type === 'argument_list') {
        const call = parent.parent;
        const functionNode = call?.type === 'call' ? call.childForFieldName('function') : null;
        const firstArgument = parent.namedChildren[0];
        if (call?.type === 'call' &&
            functionNode?.type === 'identifier' &&
            firstArgument?.id === node.id &&
            IMPLEMENTATION_CALLS.has(functionNode.text)) {
            return node;
        }
    }

    return null;
}

/** Return the identifier at the cursor, including a cursor at the word end. */
function identifierNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    const clamped = Math.max(0, Math.min(offset, root.endIndex - 1));
    let node = root.descendantForIndex(clamped);
    if (!node || node.type !== 'identifier') {
        const previous = root.descendantForIndex(Math.max(0, clamped - 1));
        if (previous?.type === 'identifier') node = previous;
    }
    return node?.type === 'identifier' ? node : null;
}

/** Return a declaration string name under the cursor. */
function declarationStringNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    let node = root.descendantForIndex(Math.max(0, Math.min(offset, root.endIndex - 1)));
    if (!node || node.type !== 'string_content') {
        const previous = root.descendantForIndex(Math.max(0, Math.min(offset - 1, root.endIndex - 1)));
        if (previous?.type === 'string_content') node = previous;
    }
    if (!node || node.type !== 'string_content') return null;

    const stringNode = node.parent;
    const argumentsNode = stringNode?.parent;
    const call = argumentsNode?.parent;
    if (stringNode?.type !== 'string' ||
        argumentsNode?.type !== 'argument_list' ||
        call?.type !== 'call') {
        return null;
    }
    const functionNode = call.childForFieldName('function');
    const firstArgument = argumentsNode.namedChildren[0];
    if (functionNode?.type !== 'identifier' ||
        firstArgument?.id !== stringNode.id ||
        !STRING_NAME_CALLS.has(functionNode.text)) {
        return null;
    }
    return node;
}

/** Return any resolvable GAP symbol name under the cursor. */
export function symbolNameNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    const identifier = identifierNodeAt(root, offset);
    if (identifier) return identifier;
    return declarationStringNodeAt(root, offset);
}
