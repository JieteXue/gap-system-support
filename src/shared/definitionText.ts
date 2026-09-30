/** Extract the complete AST-delimited definition of a name or record field. */

import type { SyntaxNode } from 'web-tree-sitter';

export function definitionText(node: SyntaxNode): string {
    let current = node;
    while (current.parent?.type === 'record_selector' ||
        current.parent?.type === 'component_selector') current = current.parent;
    if (current.parent?.type === 'assignment_statement' ||
        current.parent?.type === 'record_entry') current = current.parent;
    let text = current.text.trim();
    let sibling = current.nextSibling;
    while (sibling?.type === ';') {
        text += sibling.text;
        sibling = sibling.nextSibling;
    }
    return text;
}
