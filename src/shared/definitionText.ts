/** Extract the complete AST-delimited definition of a name or record field. */

import type { SyntaxNode } from 'web-tree-sitter';

export function definitionExcerpt(node: SyntaxNode): { text: string; start: number; end: number } {
    let current = node;
    while (current.parent?.type === 'record_selector' ||
        current.parent?.type === 'component_selector') current = current.parent;
    if (current.parent?.type === 'assignment_statement' ||
        current.parent?.type === 'record_entry') current = current.parent;
    if (current.type === 'string_content') current = current.parent!;
    if (current.parent?.type === 'argument_list' && current.parent.parent?.type === 'call') {
        current = current.parent.parent;
    }
    let text = current.text.trim();
    const start = current.startIndex + current.text.length - current.text.trimStart().length;
    let end = current.endIndex - (current.text.length - current.text.trimEnd().length);
    let sibling = current.nextSibling;
    while (sibling?.type === ';') {
        text += sibling.text;
        end = sibling.endIndex;
        sibling = sibling.nextSibling;
    }
    return { text, start, end };
}

export function definitionText(node: SyntaxNode): string {
    return definitionExcerpt(node).text;
}
