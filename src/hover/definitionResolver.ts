/** Resolve the active function definition for a hover position. */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getDocumentTree, isParserReady } from '../parser/gapParser';
import { hasErrorAncestor } from '../shared/treeUtils';
import { ReadChainFileCache, resolveReadBaseDir, resolveReadTarget } from '../shared/readFileCache';
import { LruCache } from '../shared/lruCache';
import { LazyQuery } from '../shared/lazyQuery';
import { recordEntryLookupName } from '../shared/functionName';
import { definitionText } from '../shared/definitionText';
import { resolveValueFieldDefinitions } from './valueOriginResolver';
import type { ValueSource } from './valueOriginResolver';
import type { QueryMatch, SyntaxNode, Tree } from 'web-tree-sitter';
import { HOVER_DOCUMENT_CACHE_MAX_ENTRIES, READ_CONTENT_LIMIT, WORKSPACE_SYMBOL_CACHE_MAX_ENTRIES } from '../limits';

const WORKSPACE_SYMBOL_CACHE_MS = 5000;

/** A definition or Read call in the backward scan. */
type FileEvent =
    | {
        kind: 'def';
        name: string;
        offset: number;
        end: number;
        /** Start index of the enclosing scope, -1 for the global scope. */
        scope: number;
        row: number;
        /** Column of the definition name, zero-based. */
        column: number;
        /**
         * The function header text from the syntax tree.
         * Null for lambdas and definitions without a parameter list.
         */
        headerText: string | null;
        definitionText?: string;
        symbolKind: 'parameter' | 'variable' | 'function' | 'global-function' | 'operation' | 'method' | 'attribute' | 'global';
        role: 'local' | 'declaration' | 'implementation';
    }
    | { kind: 'read'; pathText: string; offset: number }
    | {
        kind: 'alias';
        name: string;
        target: string;
        offset: number;
        end: number;
        scope: number;
    };

/** The key of the always visible global scope. */
const GLOBAL_SCOPE = -1;

/** Parsed file view with events and source lines. */
interface EventFile {
    events: FileEvent[];
    /** Source lines without trailing line breaks. */
    lines: string[];
    document: vscode.TextDocument;
}

interface DocumentModel extends EventFile {
    version: number;
    tree: Tree;
    text: string;
    scopeByStart: Set<number>;
    lineOffsets: number[];
    aliases?: {
        baseDir: string | null;
        expiresAt: number;
        revision: number;
        changes: Map<string, { offset: number; target: string }[]>;
    };
}

interface DefinitionCandidate {
    event: Extract<FileEvent, { kind: 'def' }>;
    lines: string[];
    filePath: string;
}

export type DefinitionSymbolKind =
    | 'parameter'
    | 'variable'
    | 'function'
    | 'global-function'
    | 'operation'
    | 'method'
    | 'attribute'
    | 'global';

/** The resolved definition shown in a hover. */
export interface ResolvedDefinition {
    /** The trimmed definition line. */
    definitionLine: string;
    /** Complete AST-delimited definition for the hover code block. */
    definitionText?: string;
    /** Comment lines directly above the definition. */
    commentLines: string[];
    /** Absolute path of the file containing the definition, or '' for untitled. */
    filePath: string;
    /** Row of the definition line, zero-based. */
    row: number;
    /** Column of the definition name, zero-based. */
    column: number;
    /** Static symbol category when available. */
    symbolKind?: DefinitionSymbolKind;
}

interface WorkspaceSymbolCacheEntry {
    expiresAt: number;
    symbols: Map<string, DefinitionCandidate[]>;
}

export class GAPDefinitionResolver {

    private readonly query: LazyQuery;
    private readonly fileCache = new ReadChainFileCache<EventFile>(
        (content, filePath) => this.parseFile(content, filePath),
    );

    constructor(completionPath: string) {
        this.query = new LazyQuery(fs.readFileSync(completionPath, 'utf-8'));
    }

    // Cache the parsed event list and source lines for each document version.
    private readonly documentCache = new LruCache<string, DocumentModel>({
        maxEntries: HOVER_DOCUMENT_CACHE_MAX_ENTRIES,
    });
    private readonly workspaceSymbolCache = new LruCache<string, WorkspaceSymbolCacheEntry>({
        maxEntries: WORKSPACE_SYMBOL_CACHE_MAX_ENTRIES,
    });
    private resolvingValueFields = false;
    private workspaceRevision = 0;

    onDocumentClosed(uri: vscode.Uri): void {
        this.fileCache.onDocumentClosed(uri);
        this.documentCache.delete(uri.toString());
        this.onWorkspaceFilesChanged();
    }

    onWorkspaceFilesChanged(): void {
        this.workspaceSymbolCache.clear();
        this.workspaceRevision++;
    }

    private documentModel(document: vscode.TextDocument, text = document.getText()): DocumentModel | null {
        if (!isParserReady() || text.length > READ_CONTENT_LIMIT) return null;
        const tree = getDocumentTree(document, text);
        const key = document.uri.toString();
        const cached = this.documentCache.peek(key);
        if (cached?.version === document.version && cached.text === text) {
            cached.tree = tree;
            cached.document = document;
            this.documentCache.touch(key, cached);
            return cached;
        }
        const collected = this.collectEvents(tree.rootNode);
        const lines = text.split(/\r?\n/);
        const lineOffsets = [0];
        for (let index = 0; index < text.length; index++) {
            if (text[index] === '\n') lineOffsets.push(index + 1);
        }
        const model: DocumentModel = {
            document, text, lines, lineOffsets, tree, version: document.version,
            events: collected.events.sort((a, b) => a.offset - b.offset),
            scopeByStart: collected.scopeByStart,
        };
        this.documentCache.set(key, model);
        return model;
    }

    private valueSource(filePath: string, current: vscode.TextDocument): ValueSource | null {
        const document = !filePath || filePath === current.uri.fsPath ? current :
            vscode.workspace.textDocuments.find(item => item.uri.fsPath === filePath) ??
            this.fileCache.loadFile(filePath)?.document;
        if (!document) return null;
        const model = this.documentModel(document);
        return model ? {
            document,
            tree: model.tree,
            lines: model.lines,
            offsetAt: position => (model.lineOffsets[position.line] ?? model.text.length) + position.character,
        } : null;
    }

    /** Resolve the active definition for the given function name. */
    resolveDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        name: string,
    ): ResolvedDefinition | null {
        const model = this.documentModel(document);
        if (!model) return null;
        const { tree, events, scopeByStart, lines } = model;
        const offset = document.offsetAt(position);

        const baseDir = resolveReadBaseDir(document);
        // Untitled documents have no real file: no Go to Definition link.
        const currentFilePath = document.isUntitled ? '' : document.uri.fsPath;
        const visible = this.visibleScopes(tree, offset, scopeByStart);
        const lookupNames = this.resolveAliasNames(model, name, offset, baseDir);
        const resolutionNames = lookupNames.size > 1
            ? new Set([...lookupNames].filter(candidate => candidate !== name))
            : lookupNames;

        // Phase 0: hovering the definition's own name shows that definition.
        for (const event of events) {
            if (event.kind === 'def' && event.name === name && event.offset <= offset && offset <= event.end) {
                return this.toDefinition({ lines, row: event.row, column: event.column, filePath: currentFilePath, headerText: event.headerText, definitionText: event.definitionText, name: event.name, symbolKind: event.symbolKind });
            }
        }

        // Phase 1: scoped lookup, the same visibility rules as scoped completion.
        const scoped = events.filter(
            (e): e is Extract<FileEvent, { kind: 'def' }> =>
                e.kind === 'def' && visible.has(e.scope) && e.end < offset &&
                resolutionNames.has(e.name),
        );
        const scopedHit = this.pickLatest(scoped);
        if (scopedHit) {
            return this.toDefinition({ lines, row: scopedHit.row, column: scopedHit.column, filePath: currentFilePath, headerText: scopedHit.headerText, definitionText: scopedHit.definitionText, name: scopedHit.name, symbolKind: scopedHit.symbolKind });
        }

        // Phase 2: global fallback over Read chains and remaining global events.
        // Only events at or before the hover offset take part; Read events keep the chain order.
        const globalScan = events.filter(
            e => e.offset <= offset &&
                (e.kind === 'read' || (e.kind === 'def' && e.scope === GLOBAL_SCOPE)),
        );
        const start = this.scanBackwards(globalScan, lines, resolutionNames, baseDir, new Set(), currentFilePath);
        if (start) return this.toDefinition(start);
        if (resolutionNames.size !== 1 || !resolutionNames.has(name)) {
            const fallback = this.scanBackwards(globalScan, lines, new Set([name]), baseDir, new Set(), currentFilePath);
            return fallback ? this.toDefinition(fallback) : null;
        }
        return null;
    }

    /**
     * Resolve a symbol from Read calls that occur later in the current file.
     * This is useful for guards such as `if not IsBound(name) then`, where the
     * guarded bootstrap intentionally loads the definition after the check.
     */
    resolveDefinitionFromFutureReads(
        document: vscode.TextDocument,
        position: vscode.Position,
        name: string,
    ): ResolvedDefinition | null {
        const model = this.documentModel(document);
        if (!model) return null;
        const { events } = model;
        const offset = document.offsetAt(position);
        const baseDir = resolveReadBaseDir(document);
        if (!baseDir) return null;
        const currentFilePath = document.isUntitled ? '' : document.uri.fsPath;
        const visited = new Set<string>();

        for (const event of events) {
            if (event.kind !== 'read' || event.offset <= offset) continue;
            const target = resolveReadTarget(event.pathText, baseDir);
            if (!target || visited.has(target)) continue;
            visited.add(target);
            const read = this.fileCache.loadFile(target);
            if (!read) continue;
            const candidate = this.scanBackwards(
                read.events,
                read.lines,
                new Set([name]),
                baseDir,
                visited,
                target,
            );
            if (candidate) {
                return this.toDefinition({
                    lines: candidate.lines,
                    row: candidate.row,
                    column: candidate.column,
                    filePath: candidate.filePath || currentFilePath,
                    headerText: candidate.headerText,
                    definitionText: candidate.definitionText,
                    name: candidate.name,
                    symbolKind: candidate.symbolKind,
                });
            }
        }
        return null;
    }

    /** Resolve a top-level symbol anywhere in the current workspace. */
    resolveWorkspaceDefinition(
        document: vscode.TextDocument,
        name: string,
    ): ResolvedDefinition | null {
        const baseDir = resolveReadBaseDir(document);
        if (!baseDir) return null;
        const currentFilePath = document.isUntitled ? '' : document.uri.fsPath;
        const candidate = this.scanWorkspaceSymbolDefinitionsCached(
            baseDir,
            name,
            currentFilePath,
        )[0];
        return candidate ? this.toDefinition({
            lines: candidate.lines,
            row: candidate.event.row,
            column: candidate.event.column,
            filePath: candidate.filePath,
            headerText: candidate.event.headerText,
            definitionText: candidate.event.definitionText,
            name: candidate.event.name,
            symbolKind: candidate.event.symbolKind,
        }) : null;
    }

    /** Expand aliases at the cursor for all symbol consumers. */
    resolveLookupNames(
        document: vscode.TextDocument,
        position: vscode.Position,
        name: string,
    ): string[] {
        const model = this.documentModel(document);
        if (!model) return [name];
        return [...this.resolveAliasNames(
            model, name, document.offsetAt(position), resolveReadBaseDir(document),
        )];
    }

    /** Resolve all static declaration/installation locations for a GAP symbol. */
    resolveDefinitions(
        document: vscode.TextDocument,
        position: vscode.Position,
        name: string,
    ): ResolvedDefinition[] {
        const symbolDefinitions = this.resolveSymbolDefinitions(document, position, name);
        if (symbolDefinitions.length > 0) return symbolDefinitions;
        const definition = this.resolveDefinition(document, position, name);
        if (definition) return [definition];
        if (this.resolvingValueFields || !name.includes('.')) return [];
        this.resolvingValueFields = true;
        try {
            return resolveValueFieldDefinitions(document, position, name,
                (source, at, lookupName) => this.resolveDefinitions(source, at, lookupName),
                filePath => this.valueSource(filePath, document));
        } finally {
            this.resolvingValueFields = false;
        }
    }

    private resolveSymbolDefinitions(
        document: vscode.TextDocument,
        position: vscode.Position,
        name: string,
    ): ResolvedDefinition[] {
        const model = this.documentModel(document);
        if (!model) return [];
        const { events, lines } = model;
        const baseDir = resolveReadBaseDir(document);
        const currentFilePath = document.isUntitled ? '' : document.uri.fsPath;
        const offset = document.offsetAt(position);
        const lookupNames = this.resolveAliasNames(model, name, offset, baseDir);
        const resolutionNames = lookupNames.size > 1
            ? [...lookupNames].filter(candidate => candidate !== name)
            : [...lookupNames];
        const candidates = resolutionNames.flatMap(lookupName => this.scanAllSymbolDefinitions(
            events, lines, lookupName, offset, baseDir, new Set(), currentFilePath, true,
        ));
        if (candidates.length === 0 && baseDir) {
            const names = resolutionNames.length > 0 ? resolutionNames : [name];
            for (const lookupName of names) {
                candidates.push(...this.scanWorkspaceSymbolDefinitionsCached(baseDir, lookupName, currentFilePath));
            }
        }
        if (candidates.length === 0 && resolutionNames.length !== 1) {
            candidates.push(...this.scanAllSymbolDefinitions(
                events, lines, name, offset, baseDir, new Set(), currentFilePath, true,
            ));
        }

        const seen = new Set<string>();
        return candidates
            .filter(candidate => {
                const key = `${candidate.filePath}:${candidate.event.row}:${candidate.event.column}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            })
            .sort((left, right) => {
                const roleOrder = (role: 'local' | 'declaration' | 'implementation') =>
                    role === 'implementation' ? 0 : role === 'declaration' ? 1 : 2;
                return roleOrder(left.event.role) - roleOrder(right.event.role) ||
                    left.filePath.localeCompare(right.filePath) ||
                    left.event.row - right.event.row ||
                    left.event.column - right.event.column;
            })
            .map(candidate => this.toDefinition({
                lines: candidate.lines,
                row: candidate.event.row,
                column: candidate.event.column,
                filePath: candidate.filePath,
                headerText: candidate.event.headerText,
                definitionText: candidate.event.definitionText,
                name: candidate.event.name,
                symbolKind: candidate.event.symbolKind,
            }));
    }

    private scanWorkspaceSymbolDefinitionsCached(
        baseDir: string,
        name: string,
        currentFilePath: string,
    ): DefinitionCandidate[] {
        const now = Date.now();
        let cached = this.workspaceSymbolCache.peek(baseDir);
        if (!cached || cached.expiresAt <= now) {
            cached = {
                expiresAt: now + WORKSPACE_SYMBOL_CACHE_MS,
                symbols: this.scanWorkspaceSymbolDefinitions(baseDir),
            };
            this.workspaceSymbolCache.set(baseDir, cached);
        } else {
            this.workspaceSymbolCache.touch(baseDir, cached);
        }
        return (cached.symbols.get(name) ?? []).filter(candidate => candidate.filePath !== currentFilePath);
    }

    /** Find top-level user definitions in sibling GAP source files. */
    private scanWorkspaceSymbolDefinitions(
        baseDir: string,
    ): Map<string, DefinitionCandidate[]> {
        const symbols = new Map<string, DefinitionCandidate[]>();
        const visited = new Set<string>();
        const sourceExtensions = new Set(['.g', '.gd', '.gi', '.gap']);

        const visit = (directory: string): void => {
            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(directory, { withFileTypes: true });
            } catch {
                return;
            }
            for (const entry of entries) {
                if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'out') continue;
                const filePath = path.join(directory, entry.name);
                if (entry.isDirectory()) {
                    visit(filePath);
                    continue;
                }
                if (!entry.isFile() || !sourceExtensions.has(path.extname(entry.name).toLowerCase())) continue;
                if (visited.has(filePath)) continue;
                visited.add(filePath);
                const read = this.fileCache.loadFile(filePath);
                if (!read) continue;
                for (const event of read.events) {
                    if (event.kind === 'def' && event.scope === GLOBAL_SCOPE) {
                        const candidate = { event, lines: read.lines, filePath };
                        const bucket = symbols.get(event.name);
                        if (bucket) bucket.push(candidate);
                        else symbols.set(event.name, [candidate]);
                    }
                }
            }
        };

        visit(baseDir);
        return symbols;
    }

    private scanAllSymbolDefinitions(
        events: FileEvent[],
        lines: string[],
        name: string,
        maxOffset: number,
        baseDir: string | null,
        visited: Set<string>,
        currentFilePath: string,
        currentFile: boolean,
    ): { event: Extract<FileEvent, { kind: 'def' }>; lines: string[]; filePath: string }[] {
        const results: { event: Extract<FileEvent, { kind: 'def' }>; lines: string[]; filePath: string }[] = [];
        for (let index = events.length - 1; index >= 0; index--) {
            const event = events[index];
            if (event.kind === 'def') {
                if (event.role !== 'local' &&
                    event.name === name &&
                    (!currentFile || event.offset <= maxOffset)) {
                    results.push({ event, lines, filePath: currentFilePath });
                }
                continue;
            }

            if (event.kind !== 'read') continue;
            if (!baseDir || (currentFile && event.offset > maxOffset)) continue;
            const target = resolveReadTarget(event.pathText, baseDir);
            if (!target || visited.has(target)) continue;
            visited.add(target);
            const read = this.fileCache.loadFile(target);
            if (!read) continue;
            results.push(...this.scanAllSymbolDefinitions(
                read.events,
                read.lines,
                name,
                Number.POSITIVE_INFINITY,
                baseDir,
                visited,
                target,
                false,
            ));
        }
        return results;
    }

    /** Collect the scope keys visible at the offset, mirroring scoped.ts getItems. */
    private visibleScopes(tree: Tree, offset: number, scopeByStart: Set<number>): Set<number> {
        const clamped = Math.max(0, Math.min(offset, tree.rootNode.endIndex));
        const visible = new Set<number>([GLOBAL_SCOPE]);
        let current: SyntaxNode | null =
            clamped >= tree.rootNode.endIndex ? tree.rootNode : tree.rootNode.descendantForIndex(clamped);
        while (current && current.type !== 'source_file') {
            if (current.type === 'ERROR') {
                // Scopes inside an ERROR subtree are unreliable, drop them.
                visible.clear();
                visible.add(GLOBAL_SCOPE);
            } else if (scopeByStart.has(current.startIndex)) {
                visible.add(current.startIndex);
            }
            current = current.parent;
        }
        return visible;
    }

    /** Pick the latest definition when the lookup has already been normalized. */
    private pickLatest(defs: Extract<FileEvent, { kind: 'def' }>[]) {
        let best: Extract<FileEvent, { kind: 'def' }> | null = null;
        for (const definition of defs) {
            if (!best || definition.end > best.end) best = definition;
        }
        return best;
    }

    /**
     * Expand direct GAP aliases such as `ME := MagneticEquivalence`.
     * This is deliberately conservative: only aliases visible before the
     * cursor and reachable through literal Read() calls are considered.
     */
    private resolveAliasNames(
        model: DocumentModel,
        name: string,
        maxOffset: number,
        baseDir: string | null,
    ): Set<string> {
        let aliases = model.aliases;
        const now = Date.now();
        if (!aliases || aliases.baseDir !== baseDir || aliases.expiresAt <= now ||
            aliases.revision !== this.workspaceRevision) {
            const changes = new Map<string, { offset: number; target: string }[]>();
            const visited = new Set<string>();
            const collect = (events: FileEvent[], readOffset?: number): void => {
                for (const event of events) {
                    const offset = readOffset ?? event.offset;
                    if (event.kind === 'alias' && event.scope === GLOBAL_SCOPE) {
                        const bucket = changes.get(event.name);
                        const binding = { offset, target: event.target };
                        if (bucket) bucket.push(binding);
                        else changes.set(event.name, [binding]);
                    } else if (event.kind === 'read' && baseDir) {
                        const target = resolveReadTarget(event.pathText, baseDir);
                        if (!target || visited.has(target)) continue;
                        visited.add(target);
                        const read = this.fileCache.loadFile(target);
                        if (read) collect(read.events, offset);
                    }
                }
            };
            collect(model.events);
            aliases = { baseDir, changes, revision: this.workspaceRevision,
                expiresAt: now + WORKSPACE_SYMBOL_CACHE_MS };
            model.aliases = aliases;
        }
        const names = new Set<string>([name]);
        const suffixIndex = name.indexOf('.');
        const root = suffixIndex < 0 ? name : name.slice(0, suffixIndex);
        const suffix = suffixIndex < 0 ? '' : name.slice(suffixIndex);
        const seenRoots = new Set<string>();
        let currentRoot = root;
        while (!seenRoots.has(currentRoot)) {
            seenRoots.add(currentRoot);
            const bindings = aliases.changes.get(currentRoot) ?? [];
            let low = 0;
            let high = bindings.length;
            while (low < high) {
                const middle = (low + high) >>> 1;
                if (bindings[middle].offset <= maxOffset) low = middle + 1;
                else high = middle;
            }
            const target = bindings[low - 1]?.target;
            if (!target) break;
            names.add(target + suffix);
            currentRoot = target;
        }
        return names;
    }

    /** Scan backward through the current file and nested Read files. */
    private scanBackwards(
        events: FileEvent[],
        lines: string[],
        names: Set<string>,
        baseDir: string | null,
        visited: Set<string>,
        currentFilePath: string,
    ): {
        lines: string[];
        row: number;
        column: number;
        filePath: string;
        headerText: string | null;
        definitionText?: string;
        name: string;
        symbolKind: DefinitionSymbolKind;
    } | null {
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (event.kind === 'def') {
                if (names.has(event.name)) {
                    return { lines, row: event.row, column: event.column, filePath: currentFilePath, headerText: event.headerText, definitionText: event.definitionText, name: event.name, symbolKind: event.symbolKind };
                }
            } else if (event.kind === 'read' && baseDir) {
                const target = resolveReadTarget(event.pathText, baseDir);
                if (!target || visited.has(target)) continue;
                visited.add(target);
                const read = this.fileCache.loadFile(target);
                if (!read) continue;
                const found = this.scanBackwards(read.events, read.lines, names, baseDir, visited, target);
                // Continue the upward scan if nothing was found here.
                if (found) return found;
            }
        }
        return null;
    }

    /** Return the definition line, the comment block above it, and the location. */
    private toDefinition(start: {
        lines: string[];
        row: number;
        column: number;
        filePath: string;
        headerText: string | null;
        definitionText?: string;
        name: string;
        symbolKind?: DefinitionSymbolKind;
    }): ResolvedDefinition {
        const rawLine = (start.lines[start.row] ?? '').trim();
        // The display line is `name := header` (e.g. `a := function(x, y)`).
        // This drops inline comments and single line bodies.
        // Lambdas have no parameter list, so the raw line is shown as is.
        const definitionLine =
            start.headerText !== null ? `${start.name} := ${start.headerText}` : rawLine;
        const commentLines: string[] = [];
        for (let row = start.row - 1; row >= 0; row--) {
            const line = (start.lines[row] ?? '').trimStart();
            if (!line.startsWith('##')) break;
            commentLines.push(line.replace(/^#+ ?/, ''));
        }
        commentLines.reverse();
        return {
            definitionLine,
            definitionText: start.definitionText,
            commentLines,
            filePath: start.filePath,
            row: start.row,
            column: start.column,
            symbolKind: start.symbolKind,
        };
    }

    /** Collect definition and Read events plus the scope index for one parsed file. */
    private collectEvents(rootNode: SyntaxNode): { events: FileEvent[]; scopeByStart: Set<number> } {
        const events: FileEvent[] = [];
        // Scope nodes of this file, from the shared completion.scm capture.
        const scopeByStart = new Set<number>();
        const defNodes = new Map<
            string,
            {
                node: SyntaxNode;
                symbolKind: 'parameter' | 'variable' | 'function';
                lookupName?: string;
                matchStart?: number;
                matchEnd?: number;
            }
        >();
        const kindPriority = { variable: 1, parameter: 2, function: 3 } as const;
        for (const match of this.query.get().matches(rootNode) as QueryMatch[]) {
            let readFn = '';
            let readPath = '';
            let readCall: SyntaxNode | null = null;
            for (const capture of match.captures) {
                const node = capture.node;
                const symbolKind =
                    capture.name === 'completion.function' ? 'function' :
                        capture.name === 'completion.parameter' ? 'parameter' :
                            capture.name === 'completion.var' ? 'variable' :
                                null;
                if (symbolKind && !hasErrorAncestor(node)) {
                    const key = `${node.startIndex}:${node.endIndex}`;
                    const existing = defNodes.get(key);
                    if (!existing || kindPriority[symbolKind] > kindPriority[existing.symbolKind]) {
                        defNodes.set(key, {
                            node,
                            symbolKind,
                        });
                    }
                } else if (capture.name === 'completion.read-fn') {
                    if (!hasErrorAncestor(node)) readFn = node.text;
                } else if (capture.name === 'completion.read-path') {
                    if (!hasErrorAncestor(node)) readPath = node.text;
                } else if (capture.name === 'completion.read-call') {
                    readCall = node;
                } else if (capture.name === 'completion.scope') {
                    if (!hasErrorAncestor(node)) scopeByStart.add(node.startIndex);
                }
            }
            if (readFn === 'Read' && readPath && readCall && !hasErrorAncestor(readCall)) {
                events.push({ kind: 'read', pathText: readPath, offset: readCall.endIndex });
            }
        }

        // Record fields are definitions too. They are intentionally collected
        // from the AST because completion.scm only models lexical variables.
        const collectRecordFields = (node: SyntaxNode): void => {
            if (node.type === 'record_entry') {
                const left = node.childForFieldName('left');
                if (left?.type === 'identifier' && !hasErrorAncestor(left)) {
                    const key = `${left.startIndex}:${left.endIndex}`;
                    const existing = defNodes.get(key);
                    if (!existing || kindPriority.variable > kindPriority[existing.symbolKind]) {
                        defNodes.set(key, {
                            node: left,
                            symbolKind: 'variable',
                            lookupName: recordEntryLookupName(node) ?? left.text,
                        });
                    }
                }
            }
            if (node.type === 'assignment_statement') {
                const left = node.childForFieldName('left');
                const selector = left?.type === 'record_selector' || left?.type === 'component_selector'
                    ? left.childForFieldName('selector')
                    : null;
                if (selector?.type === 'identifier' && !hasErrorAncestor(selector)) {
                    const key = `${selector.startIndex}:${selector.endIndex}`;
                    const existing = defNodes.get(key);
                    if (!existing || kindPriority.variable > kindPriority[existing.symbolKind]) {
                        defNodes.set(key, {
                            node: selector,
                            symbolKind: 'variable',
                            lookupName: left!.text,
                            matchStart: left!.startIndex,
                            matchEnd: left!.endIndex,
                        });
                    }
                }
            }
            for (const child of node.namedChildren) collectRecordFields(child);
        };
        collectRecordFields(rootNode);

        // Preserve simple value aliases for qualified-name resolution.
        const collectAliases = (node: SyntaxNode): void => {
            if (node.type === 'assignment_statement') {
                const left = node.childForFieldName('left');
                const right = node.childForFieldName('right');
                if (left?.type === 'identifier' &&
                    (right?.type === 'identifier' ||
                        right?.type === 'record_selector' ||
                        right?.type === 'component_selector') &&
                    !hasErrorAncestor(left) &&
                    !hasErrorAncestor(right)) {
                    let scope = GLOBAL_SCOPE;
                    let current: SyntaxNode | null = left.parent;
                    while (current && current.type !== 'source_file') {
                        if (scopeByStart.has(current.startIndex)) {
                            scope = current.startIndex;
                            break;
                        }
                        current = current.parent;
                    }
                    events.push({
                        kind: 'alias',
                        name: left.text,
                        target: right.text,
                        offset: left.startIndex,
                        end: left.endIndex,
                        scope,
                    });
                }
            }
            for (const child of node.namedChildren) collectAliases(child);
        };
        collectAliases(rootNode);

        // Attach every definition to its innermost enclosing scope, as scoped.ts does.
        for (const {
            node,
            symbolKind,
            lookupName,
            matchStart,
            matchEnd,
        } of defNodes.values()) {
            let scope = GLOBAL_SCOPE;
            let current: SyntaxNode | null = node.parent;
            while (current && current.type !== 'source_file') {
                if (scopeByStart.has(current.startIndex)) {
                    scope = current.startIndex;
                    break;
                }
                current = current.parent;
            }
            events.push({
                kind: 'def',
                name: lookupName ?? node.text,
                offset: matchStart ?? node.startIndex,
                end: matchEnd ?? node.endIndex,
                scope,
                row: node.startPosition.row,
                column: node.startPosition.column,
                headerText: this.functionHeaderText(node),
                definitionText: definitionText(node),
                symbolKind,
                role: 'local',
            });
        }
        events.push(...this.collectGapSymbolEvents(rootNode));
        return { events, scopeByStart };
    }

    /** Collect global declaration and installation calls from the AST. */
    private collectGapSymbolEvents(rootNode: SyntaxNode): Extract<FileEvent, { kind: 'def' }>[] {
        const events: Extract<FileEvent, { kind: 'def' }>[] = [];
        const declarations = new Map<string, Extract<FileEvent, { kind: 'def' }>['symbolKind']>([
            ['DeclareGlobalFunction', 'global-function'],
            ['DeclareGlobalName', 'global'],
            ['DeclareGlobalVariable', 'global'],
            ['DeclareOperation', 'operation'],
            ['DeclareAttribute', 'attribute'],
            ['DeclareProperty', 'attribute'],
            ['DeclareCategory', 'attribute'],
            ['DeclareFilter', 'attribute'],
            ['DeclareRepresentation', 'attribute'],
            ['DeclareSynonym', 'global'],
            ['DeclareSynonymAttr', 'attribute'],
            ['DeclareTagBasedOperation', 'operation'],
            ['DeclareConstructor', 'global'],
            ['DeclareDataType', 'global'],
            ['DeclareInfoClass', 'global'],
            ['DeclareHasAndSet', 'global'],
            ['DeclareObsoleteSynonym', 'global'],
            ['DeclareObsoleteSynonymAttr', 'attribute'],
            ['DeclareOperationWithCache', 'operation'],
            ['DeclareAttributeWithCustomGetter', 'attribute'],
            ['DeclareAttributeThatReturnsDigraph', 'attribute'],
        ]);
        const implementations = new Map<string, Extract<FileEvent, { kind: 'def' }>['symbolKind']>([
            ['InstallGlobalFunction', 'global-function'],
            ['InstallMethod', 'method'],
            ['InstallOtherMethod', 'method'],
            ['InstallEarlyMethod', 'method'],
            ['InstallImmediateMethod', 'method'],
            ['InstallTrueMethod', 'method'],
            ['InstallTagBasedMethod', 'method'],
            ['InstallValue', 'global'],
            ['BindGlobal', 'global'],
            ['BindConstant', 'global'],
            ['BindThreadLocal', 'global'],
            ['BindThreadLocalConstructor', 'global'],
        ]);
        const isDeclarationCall = (name: string): boolean =>
            declarations.has(name) ||
            /^(?:DeclareOperation|DeclareAttribute|DeclareProperty|DeclareCategory|DeclareRepresentation|DeclareConstructor)Kernel$/.test(name) ||
            /^(?:DeclareAttribute|DeclareProperty)SuppCT$/.test(name);
        const isImplementationCall = (name: string): boolean =>
            implementations.has(name) ||
            /^Install(?:Other)?Method(?:With.*|ForCompilerForCAP|ThatReturnsDigraph)?$/.test(name);

        const visit = (node: SyntaxNode): void => {
            if (node.type === 'call') {
                const functionNode = node.childForFieldName('function');
                const argumentsNode = node.childForFieldName('arguments');
                const firstArgument = argumentsNode?.namedChildren[0];
                const functionName = functionNode?.type === 'identifier' ? functionNode.text : undefined;
                const symbolKind = functionName
                    ? declarations.get(functionName) ??
                        implementations.get(functionName) ??
                        (isDeclarationCall(functionName) ? 'global' : undefined) ??
                        (isImplementationCall(functionName) ? 'global' : undefined)
                    : undefined;

                if (symbolKind && firstArgument) {
                    const role = isDeclarationCall(functionName!)
                        ? 'declaration' as const
                        : 'implementation' as const;
                    let nameNode: SyntaxNode | null = null;
                    if (role === 'declaration' &&
                        firstArgument.type === 'string') {
                        nameNode = firstArgument.namedChildren.find(child => child.type === 'string_content') ?? null;
                    } else if (role === 'implementation') {
                        if ((functionName === 'BindGlobal' ||
                            functionName === 'BindConstant' ||
                            functionName === 'BindThreadLocalConstructor') &&
                            firstArgument.type === 'string') {
                            nameNode = firstArgument.namedChildren.find(
                                child => child.type === 'string_content',
                            ) ?? null;
                        } else {
                            nameNode = firstArgument.type === 'identifier'
                                ? firstArgument
                                : firstArgument.type === 'record_selector' ||
                                    firstArgument.type === 'component_selector'
                                    ? firstArgument.childForFieldName('selector')
                                    : null;
                        }
                    } else if (role === 'declaration' && firstArgument.type === 'identifier') {
                        nameNode = firstArgument;
                    }
                    if (nameNode && !hasErrorAncestor(nameNode)) {
                        events.push({
                            kind: 'def',
                            name: firstArgument.type === 'record_selector' ||
                                firstArgument.type === 'component_selector'
                                ? firstArgument.text
                                : nameNode.text,
                            offset: nameNode.startIndex,
                            end: nameNode.endIndex,
                            scope: GLOBAL_SCOPE,
                            row: nameNode.startPosition.row,
                            column: nameNode.startPosition.column,
                            headerText: null,
                            definitionText: definitionText(node),
                            symbolKind,
                            role,
                        });
                    }
                }
            }
            for (const child of node.namedChildren) visit(child);
        };

        visit(rootNode);
        return events;
    }

    /**
     * Slice the function header text from the syntax tree.
     * Returns null for lambdas and definitions without a parameter list.
     * Multiline parameter lists are flattened to single spaces.
     */
    private functionHeaderText(fnNode: SyntaxNode): string | null {
        const parent = fnNode.parent;
        if (!parent || parent.type !== 'assignment_statement') return null;
        const right = parent.childForFieldName('right');
        if (!right || (right.type !== 'function' && right.type !== 'atomic_function')) return null;
        const params = right.childForFieldName('parameters');
        if (!params) return null;
        return right.text.slice(0, params.endIndex - right.startIndex).replace(/\s+/g, ' ').trimEnd();
    }

    private parseFile(content: string, filePath: string): EventFile | null {
        const open = vscode.workspace.textDocuments.find(item => item.uri.fsPath === filePath);
        const offsets = [0];
        for (let index = 0; index < content.length; index++) {
            if (content[index] === '\n') offsets.push(index + 1);
        }
        const document = open ?? {
            uri: vscode.Uri.file(filePath),
            version: 1,
            isUntitled: false,
            getText: () => content,
            offsetAt: (position: vscode.Position) =>
                (offsets[position.line] ?? content.length) + position.character,
        } as vscode.TextDocument;
        const model = this.documentModel(document, content);
        return model ? {
            document,
            events: model.events.filter(event => event.kind === 'read' || event.scope === GLOBAL_SCOPE),
            lines: model.lines,
        } : null;
    }
}
