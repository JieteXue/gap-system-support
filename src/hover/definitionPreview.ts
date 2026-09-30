/** Immutable source-mapped previews shared by native Hover and the definition panel. */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getDocumentTree, parseGapCode } from '../parser/gapParser';
import { definitionExcerpt } from '../shared/definitionText';
import { symbolLookupName, symbolNameNodeAt } from '../shared/functionName';
import { LazyQuery } from '../shared/lazyQuery';
import { LruCache } from '../shared/lruCache';
import { INSPECTION_CACHE_MAX_ENTRIES, INSPECTION_MAX_TOKENS, READ_CONTENT_LIMIT } from '../limits';
import { GAPDefinitionResolver, ResolvedDefinition } from './definitionResolver';
import { GAPHoverProvider } from './hoverProvider';
import type { SyntaxNode, Tree } from 'web-tree-sitter';

export interface PreviewToken {
    id: number;
    start: number;
    end: number;
    row: number;
    column: number;
    kind: string;
    name?: string;
}

export interface DefinitionPreview {
    title: string;
    category: string;
    text: string;
    comments: string[];
    tokens: PreviewToken[];
    uri: string;
    sourceLabel: string;
    row: number;
    column: number;
    /** First displayed source line, which can precede the definition name. */
    startRow: number;
    builtin?: string;
    document: vscode.TextDocument;
    sourceText: string;
    revision: number;
}

function highlightKind(name: string): string {
    if (name.startsWith('variable.member')) return 'field';
    if (name.startsWith('variable.parameter')) return 'parameter';
    return name.split('.')[0];
}

export class DefinitionPreviewService {
    private readonly highlights: LazyQuery;
    private readonly cache = new LruCache<string, {
        text: string; expiresAt: number; previews: DefinitionPreview[];
    }>({ maxEntries: INSPECTION_CACHE_MAX_ENTRIES });
    private readonly definitions = new LruCache<string, DefinitionPreview>({
        maxEntries: INSPECTION_CACHE_MAX_ENTRIES,
    });

    constructor(
        private readonly resolver: GAPDefinitionResolver,
        private readonly hover: GAPHoverProvider,
        highlightPath: string,
    ) {
        this.highlights = new LazyQuery(fs.readFileSync(highlightPath, 'utf8'));
    }

    clear(): void {
        this.cache.clear();
        this.definitions.clear();
    }

    dispose(): void {
        this.clear();
        this.highlights.dispose();
    }

    isFresh(preview: DefinitionPreview): boolean {
        return this.sourceFresh(preview.document, preview.sourceText, preview.revision);
    }

    sourceFresh(document: vscode.TextDocument, text: string, revision: number): boolean {
        if (revision !== this.resolver.revision) return false;
        const current = document.isUntitled ? document : this.resolver.readSourceDocument(document.uri.fsPath);
        return !!current && current.getText() === text;
    }

    at(document: vscode.TextDocument, position: vscode.Position): DefinitionPreview[] {
        const text = document.getText();
        if (text.length > READ_CONTENT_LIMIT) return [];
        const key = `${document.uri.toString()}:${document.version}:${document.offsetAt(position)}:${this.resolver.revision}`;
        const cached = this.cache.peek(key);
        if (cached?.text === text && cached.expiresAt > Date.now() &&
            cached.previews.every(preview => this.isFresh(preview))) {
            this.cache.touch(key, cached);
            return cached.previews;
        }
        const info = this.hover.resolveSymbol(document, position);
        if (!info) return [];
        let previews: DefinitionPreview[];
        if (info.builtin) {
            const help = info.builtin === true ? undefined : info.builtin;
            const signature = help?.display ?? `${info.name}(...)`;
            const signatureTree = parseGapCode(signature);
            let tokens: PreviewToken[];
            try {
                tokens = this.highlightTokens(signatureTree, 0, signature.length);
            } finally {
                signatureTree.delete();
            }
            previews = [{
                title: info.name, category: info.symbolType, text: signature,
                comments: help?.description ? [help.description] : [], tokens,
                uri: document.uri.toString(), sourceLabel: 'GAP Help', row: position.line,
                column: position.character, builtin: info.name,
                startRow: 0,
                document, sourceText: text, revision: this.resolver.revision,
            }];
        } else {
            previews = info.definitions.flatMap(definition => {
                const preview = this.definition(definition, document, info.name, info.symbolType);
                return preview ? [preview] : [];
            });
        }
        this.cache.set(key, { text, previews, expiresAt: Date.now() + 5000 });
        return previews;
    }

    definition(
        definition: ResolvedDefinition, current: vscode.TextDocument,
        title?: string, category = definition.symbolKind ?? 'symbol',
    ): DefinitionPreview | null {
        const document = this.resolver.sourceDocument(definition.filePath, current);
        if (!document) return null;
        const sourceText = document.getText();
        if (sourceText.length > READ_CONTENT_LIMIT) return null;
        const key = `${document.uri.toString()}:${document.version}:${definition.row}:${definition.column}:${this.resolver.revision}`;
        const cached = this.definitions.peek(key);
        if (cached?.sourceText === sourceText) {
            this.definitions.touch(key, cached);
            return { ...cached, title: title ?? cached.title, category, comments: definition.commentLines };
        }
        const tree = getDocumentTree(document, sourceText);
        const node = tree.rootNode.descendantForIndex(document.offsetAt(
            new vscode.Position(definition.row, definition.column)));
        const excerpt = definitionExcerpt(node);
        const tokens = this.highlightTokens(tree, excerpt.start, excerpt.end);
        const preview: DefinitionPreview = {
            title: symbolLookupName(node), category,
            text: sourceText.slice(excerpt.start, excerpt.end),
            comments: definition.commentLines, tokens,
            uri: document.uri.toString(), sourceLabel: path.basename(document.uri.fsPath) || 'Untitled',
            row: definition.row, column: definition.column, document, sourceText,
            startRow: tree.rootNode.descendantForIndex(excerpt.start).startPosition.row,
            revision: this.resolver.revision,
        };
        this.definitions.set(key, preview);
        return { ...preview, title: title ?? preview.title };
    }

    private highlightTokens(tree: Tree, start: number, end: number): PreviewToken[] {
        if (end <= start) return [];
        const styles = new Map<number, string>();
        for (const capture of this.highlights.get().captures(tree.rootNode, {
            startPosition: tree.rootNode.descendantForIndex(start).startPosition,
            endPosition: tree.rootNode.descendantForIndex(end - 1).endPosition,
        })) styles.set(capture.node.id, highlightKind(capture.name));
        const tokens: PreviewToken[] = [];
        const visit = (item: SyntaxNode, inherited = ''): void => {
            if (item.endIndex <= start || item.startIndex >= end ||
                tokens.length >= INSPECTION_MAX_TOKENS) return;
            const kind = styles.get(item.id) ?? inherited;
            if (item.childCount > 0) {
                for (const child of item.children) visit(child, kind);
            } else if (item.endIndex > item.startIndex) {
                const symbol = symbolNameNodeAt(tree.rootNode, item.startIndex);
                const name = symbol?.id === item.id ? symbolLookupName(item) : undefined;
                tokens.push({
                    id: tokens.length, start: Math.max(item.startIndex, start) - start,
                    end: Math.min(item.endIndex, end) - start,
                    row: item.startPosition.row, column: item.startPosition.column, kind, name,
                });
            }
        };
        visit(tree.rootNode);
        return tokens;
    }
}
