/** Provide hover content for GAP function names. */

import * as vscode from 'vscode';
import { isParserReady, getDocumentTree } from '../parser/gapParser';
import { getFunctionNames } from '../completion/dataManager';
import { GAPDefinitionResolver, ResolvedDefinition } from './definitionResolver';
import { definitionPathLink } from './format';
import { getHelpState } from '../help/helpData';
import { simpleString } from '../help/simpleString';
import { functionNameNodeAt, symbolLookupName, symbolNameNodeAt } from '../shared/functionName';
import { resolveHelpPath } from '../path';
import { BUILTIN_FUNCTION_NAMES } from '../completion/builtinNames';
import type { SyntaxNode } from 'web-tree-sitter';
import * as fs from 'fs';

/** English hover texts. */
const FALLBACK_TEXT =
    'No function information found. Please check the function name.\n\n---\n\n' +
    'User defined functions support the following forms:\n\n' +
    '- name := function(...)\n' +
    '- name := atomic function(...)\n' +
    '- name := x -> ...\n' +
    '- name := {x, y, ...} -> ...';

const KEYWORD_DESCRIPTIONS: Readonly<Record<string, { type: string; description: string }>> = {
    if: { type: 'conditional keyword', description: 'Starts a conditional block.' },
    then: { type: 'conditional keyword', description: 'Starts the body of a conditional branch.' },
    elif: { type: 'conditional keyword', description: 'Adds another condition to a conditional block.' },
    else: { type: 'conditional keyword', description: 'Starts the fallback branch of a conditional block.' },
    fi: { type: 'conditional keyword', description: 'Ends a conditional block.' },
    not: { type: 'logical operator', description: 'Negates a boolean condition.' },
    and: { type: 'logical operator', description: 'Requires both boolean conditions to be true.' },
    or: { type: 'logical operator', description: 'Requires at least one boolean condition to be true.' },
    in: { type: 'operator keyword', description: 'Tests membership or introduces a loop collection.' },
    mod: { type: 'operator keyword', description: 'Computes the remainder after integer division.' },
    function: { type: 'function keyword', description: 'Starts a function expression.' },
    local: { type: 'function keyword', description: 'Declares names local to the current function.' },
    end: { type: 'function keyword', description: 'Ends a function expression.' },
    return: { type: 'control keyword', description: 'Returns a value from the current function.' },
    for: { type: 'loop keyword', description: 'Starts a loop over a collection.' },
    while: { type: 'loop keyword', description: 'Starts a loop controlled by a condition.' },
    do: { type: 'loop keyword', description: 'Starts the body of a loop.' },
    od: { type: 'loop keyword', description: 'Ends a for or while loop.' },
    repeat: { type: 'loop keyword', description: 'Starts a loop whose condition is checked at the end.' },
    until: { type: 'loop keyword', description: 'Ends a repeat loop when its condition becomes true.' },
    break: { type: 'control keyword', description: 'Stops the nearest enclosing loop.' },
    continue: { type: 'control keyword', description: 'Continues with the next iteration of the nearest loop.' },
    rec: { type: 'type keyword', description: 'Creates a record value.' },
    atomic: { type: 'modifier keyword', description: 'Marks an atomic function or statement.' },
    readonly: { type: 'modifier keyword', description: 'Marks an atomic function parameter as read-only.' },
    readwrite: { type: 'modifier keyword', description: 'Marks an atomic function parameter as readable and writable.' },
    quit: { type: 'control keyword', description: 'Exits the current session.' },
};

function keywordNodeAt(root: SyntaxNode, offset: number): SyntaxNode | null {
    const clamped = Math.max(0, Math.min(offset, root.endIndex - 1));
    const candidates = [
        root.descendantForIndex(clamped),
        root.descendantForIndex(Math.max(0, clamped - 1)),
    ];
    for (const node of candidates) {
        if (node && KEYWORD_DESCRIPTIONS[node.text]) return node;
    }
    return null;
}

function keywordMarkdown(keyword: string): vscode.MarkdownString {
    const info = KEYWORD_DESCRIPTIONS[keyword];
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**${info.type}**\n\n`);
    md.appendMarkdown(`\`${keyword}\`\n\n${info.description}`);
    return md;
}

/**
 * Render the hover for a GAP function.
 * Shows the function title and a link into GAP Help.
 */
interface BuiltinHelp {
    display: string;
    book: string;
    description?: string;
}

const helpDescriptionCache = new Map<string, string | undefined>();

function decodeHtml(text: string): string {
    return text
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

/** Read the first short prose paragraph after a GAPDoc function anchor. */
function readHelpDescription(filePath: string, anchor: string): string | undefined {
    if (!filePath || !anchor || !fs.existsSync(filePath)) return undefined;
    const cacheKey = `${filePath}#${anchor}`;
    if (helpDescriptionCache.has(cacheKey)) return helpDescriptionCache.get(cacheKey);

    let description: string | undefined;
    try {
        const html = fs.readFileSync(filePath, 'utf8');
        const anchorIndex = html.search(new RegExp(`id=["']${anchor}["']`));
        if (anchorIndex >= 0) {
            const afterAnchor = html.slice(anchorIndex);
            const paragraph = /<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/i.exec(afterAnchor);
            if (paragraph) {
                const text = decodeHtml(paragraph[1]);
                if (text) description = text.length > 280 ? `${text.slice(0, 277).trimEnd()}...` : text;
            }
        }
    } catch {
        // A missing or unreadable documentation file should not disable Hover.
    }
    helpDescriptionCache.set(cacheKey, description);
    return description;
}

function findBuiltinHelp(name: string): BuiltinHelp | undefined {
    const key = simpleString(name);
    const entries = getHelpState().entries;
    const candidates = entries.filter(entry =>
        entry.type === 'F' &&
        (entry.key === key || entry.key === key.toLowerCase() || entry.display === name));
    const exact = candidates.sort((a, b) => {
        const score = (entry: typeof a): number =>
            (entry.display === name ? 4 : 0) +
            (entry.book === 'Reference' ? 2 : 0) +
            (entry.filePath.startsWith('/doc/') ? 1 : 0);
        return score(b) - score(a);
    })[0];
    if (!exact) return undefined;
    const config = vscode.workspace.getConfiguration('gap');
    const docPath = (config.get<string>('docPath') || '').trim();
    const pkgPath = (config.get<string>('pkgPath') || '').trim();
    return {
        display: exact.display,
        book: exact.book,
        description: readHelpDescription(resolveHelpPath(exact.filePath, docPath, pkgPath), exact.anchor),
    };
}

function systemMarkdown(name: string): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: ['gap.searchHelpTerm'] };
    const help = findBuiltinHelp(name);
    md.appendMarkdown('**built-in function**\n\n');
    md.appendMarkdown(`\`${help?.display || `${name}(...)`}\`\n\n`);
    if (help?.description) md.appendMarkdown(`${help.description}\n\n`);
    md.appendMarkdown(help
        ? `Defined in the ${help.book} help book. `
        : 'Provided by the language runtime. ');
    md.appendMarkdown('See more information in ');
    md.appendMarkdown(
        `[GAP Help](command:gap.searchHelpTerm?${encodeURIComponent(JSON.stringify([name]))})`
    );
    return md;
}

function userSymbolType(
    root: SyntaxNode,
    node: SyntaxNode,
    lookupName: string,
    resolved: ResolvedDefinition,
): string {
    if (lookupName.includes('.') || lookupName.includes('!')) return 'record field';
    if (resolved.symbolKind === 'parameter') return 'parameter';
    if (resolved.symbolKind === 'function' ||
        resolved.symbolKind === 'global-function' ||
        resolved.symbolKind === 'operation' ||
        resolved.symbolKind === 'method' ||
        resolved.symbolKind === 'attribute' ||
        functionNameNodeAt(root, node.startIndex)?.id === node.id ||
        /\b(?:atomic\s+)?function\b|->/.test(resolved.definitionLine)) {
        return 'function';
    }
    return 'variable';
}

function isIsBoundArgument(node: SyntaxNode): boolean {
    const argumentList = node.parent;
    const call = argumentList?.type === 'argument_list' ? argumentList.parent : null;
    const functionNode = call?.type === 'call' ? call.childForFieldName('function') : null;
    return functionNode?.type === 'identifier' &&
        functionNode.text === 'IsBound' &&
        argumentList?.namedChildren[0]?.id === node.id;
}

/**
 * Render the hover for a user defined function.
 * Shows the title, a code block, and the comment lines.
 * Appends a Defined in link, or skips it for untitled documents.
 */
function customMarkdown(
    resolved: ResolvedDefinition & { symbolType?: string },
): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.isTrusted = { enabledCommands: ['gap.goToDefinition'] };
    md.appendMarkdown(`**${resolved.symbolType || 'symbol'}**\n\n`);
    md.appendCodeblock(resolved.definitionLine, 'gap');
    if (resolved.commentLines.length > 0) {
        // A separator between the code block and the comments.
        md.appendMarkdown('\n\n---\n\n');
        for (const line of resolved.commentLines) {
            // Comment lines render as Markdown (bold, code, links, math syntax), one comment line per displayed line.
            // The string is not trusted, so command links stay inert.
            md.appendMarkdown(line);
            md.appendMarkdown('  \n');
        }
    }
    if (resolved.filePath) {
        md.appendMarkdown('\n---\n\n');
        md.appendMarkdown(`Defined in ${definitionPathLink(resolved.filePath, resolved.row)}`);
    }
    return md;
}

export class GAPHoverProvider implements vscode.HoverProvider {

    private resolver: GAPDefinitionResolver;

    constructor(completionPath: string) {
        this.resolver = new GAPDefinitionResolver(completionPath);
    }

    onDocumentClosed(uri: vscode.Uri): void {
        this.resolver.onDocumentClosed(uri);
    }

    onWorkspaceFilesChanged(): void {
        this.resolver.onWorkspaceFilesChanged();
    }

    provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): vscode.Hover | undefined {
        if (!isParserReady()) return undefined;

        // Gate 1: only function name identifiers trigger a hover.
        const offset = document.offsetAt(position);
        if (token.isCancellationRequested) return undefined;
        const tree = getDocumentTree(document);
        const node = symbolNameNodeAt(tree.rootNode, offset);
        if (!node) {
            const keyword = keywordNodeAt(tree.rootNode, offset);
            return keyword
                ? new vscode.Hover(keywordMarkdown(keyword.text), this.rangeOf(document, keyword))
                : undefined;
        }

        const name = symbolLookupName(node);

        // Gate 2: GAP functions win over user defined ones.
        const systemNames = getFunctionNames();
        const help = findBuiltinHelp(name);
        if (systemNames?.has(name) || BUILTIN_FUNCTION_NAMES.has(name) || help) {
            return new vscode.Hover(systemMarkdown(name), this.rangeOf(document, node));
        }

        // Gate 3: user-defined symbols resolved through the Read chain.
        let resolved = this.resolver.resolveDefinition(document, position, name);
        // A loader may use a symbol in an IsBound guard before Read() loads its definition.
        if (!resolved && isIsBoundArgument(node)) {
            resolved = this.resolver.resolveDefinitionFromFutureReads(document, position, name);
            if (!resolved) {
                resolved = this.resolver.resolveWorkspaceDefinition(document, name);
            }
        }
        if (resolved) {
            return new vscode.Hover(
                customMarkdown({
                    ...resolved,
                    symbolType: userSymbolType(tree.rootNode, node, name, resolved),
                }),
                this.rangeOf(document, node),
            );
        }

        // Preserve the old fallback only for call-like function names.
        if (functionNameNodeAt(tree.rootNode, offset)?.id === node.id) {
            return new vscode.Hover(new vscode.MarkdownString(FALLBACK_TEXT), this.rangeOf(document, node));
        }
        return undefined;
    }

    private rangeOf(document: vscode.TextDocument, node: SyntaxNode): vscode.Range {
        return new vscode.Range(
            new vscode.Position(node.startPosition.row, node.startPosition.column),
            new vscode.Position(node.endPosition.row, node.endPosition.column),
        );
    }
}
