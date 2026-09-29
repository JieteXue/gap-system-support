/** Provide native Find All References and Peek References for GAP symbols. */

import * as vscode from 'vscode';
import type { SyntaxNode } from 'web-tree-sitter';
import { getDocumentTree, isParserReady } from '../parser/gapParser';
import { GAPDefinitionResolver } from '../hover/definitionResolver';
import type { ResolvedDefinition } from '../hover/definitionResolver';
import { symbolLookupName, symbolNameNodeAt } from '../shared/functionName';
import { READ_CONTENT_LIMIT } from '../limits';

const SOURCE_GLOB = '**/*.{g,gd,gi,gap}';
const EXCLUDE_GLOB = '**/{.git,node_modules,out}/**';

function definitionKey(definition: ResolvedDefinition): string {
    return `${definition.filePath}:${definition.row}:${definition.column}`;
}

function locationKey(filePath: string, row: number, column: number): string {
    return `${filePath}:${row}:${column}`;
}

function definitionNameLength(lookupName: string): number {
    return lookupName.split(/[.!]/).filter(Boolean).pop()?.length ?? lookupName.length;
}

function isOriginLocation(
    document: vscode.TextDocument,
    position: vscode.Position,
    location: vscode.Location,
): boolean {
    if (location.uri.toString() !== document.uri.toString()) return false;
    const start = location.range.start;
    const end = location.range.end;
    if (position.line < start.line || position.line > end.line) return false;
    if (start.line === end.line) {
        return position.character >= start.character && position.character <= end.character;
    }
    if (position.line === start.line) return position.character >= start.character;
    if (position.line === end.line) return position.character <= end.character;
    return true;
}

function collectSymbolNodes(root: SyntaxNode, lookupName: string): SyntaxNode[] {
    const result: SyntaxNode[] = [];
    const visit = (node: SyntaxNode): void => {
        if (node.type === 'identifier' || node.type === 'string_content') {
            const classified = symbolNameNodeAt(root, node.startIndex);
            if (classified?.id === node.id && symbolLookupName(node) === lookupName) {
                result.push(node);
            }
        }
        for (const child of node.namedChildren) visit(child);
    };
    visit(root);
    return result;
}

export class GAPReferenceProvider implements vscode.ReferenceProvider {

    private readonly resolver: GAPDefinitionResolver;

    constructor(completionPath: string) {
        this.resolver = new GAPDefinitionResolver(completionPath);
    }

    onDocumentClosed(uri: vscode.Uri): void {
        this.resolver.onDocumentClosed(uri);
    }

    async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.ReferenceContext,
        token: vscode.CancellationToken,
    ): Promise<vscode.Location[]> {
        if (!isParserReady() || token.isCancellationRequested) return [];

        const tree = getDocumentTree(document);
        const node = symbolNameNodeAt(tree.rootNode, document.offsetAt(position));
        if (!node) return [];
        const lookupName = symbolLookupName(node);
        const definitions = this.resolver.resolveDefinitions(document, position, lookupName);
        if (definitions.length === 0) return [];

        const originFilePath = document.isUntitled ? '' : document.uri.fsPath;
        const originKey = locationKey(
            originFilePath,
            node.startPosition.row,
            node.startPosition.column,
        );
        const targetDefinitions = new Set(definitions.map(definitionKey));
        const definitionLocations = new Set(definitions.map(definitionKey));
        const documents = await this.workspaceDocuments(document, token);
        const locations: vscode.Location[] = [];
        const seen = new Set<string>();

        if (context.includeDeclaration) {
            for (const definition of definitions) {
                const key = definitionKey(definition);
                const definitionDocument = documents.find(candidate =>
                    definition.filePath === ''
                        ? candidate.uri.toString() === document.uri.toString()
                        : candidate.uri.fsPath === definition.filePath,
                );
                const uri = definitionDocument?.uri ??
                    (definition.filePath === '' ? document.uri : vscode.Uri.file(definition.filePath));
                const start = new vscode.Position(definition.row, definition.column);
                const location = new vscode.Location(
                    uri,
                    new vscode.Range(
                        start,
                        new vscode.Position(
                            definition.row,
                            definition.column + definitionNameLength(lookupName),
                        ),
                    ),
                );
                if (key === originKey || seen.has(key) ||
                    isOriginLocation(document, position, location)) continue;
                locations.push(location);
                seen.add(key);
            }
        }

        for (const candidateDocument of documents) {
            if (token.isCancellationRequested) return [];
            const text = candidateDocument.getText();
            if (text.length > READ_CONTENT_LIMIT) continue;
            const candidateTree = getDocumentTree(candidateDocument, text);
            for (const candidate of collectSymbolNodes(candidateTree.rootNode, lookupName)) {
                if (token.isCancellationRequested) return [];
                const filePath = candidateDocument.isUntitled ? '' : candidateDocument.uri.fsPath;
                const key = locationKey(
                    filePath,
                    candidate.startPosition.row,
                    candidate.startPosition.column,
                );
                const location = new vscode.Location(
                    candidateDocument.uri,
                    new vscode.Range(
                        new vscode.Position(
                            candidate.startPosition.row,
                            candidate.startPosition.column,
                        ),
                        new vscode.Position(
                            candidate.endPosition.row,
                            candidate.endPosition.column,
                        ),
                    ),
                );
                if (key === originKey || isOriginLocation(document, position, location)) continue;
                const isDefinition = definitionLocations.has(key);
                if (isDefinition && !context.includeDeclaration) continue;

                // A same-named local definition shadows a workspace symbol.
                // If static lexical resolution finds a different definition,
                // this occurrence belongs to that local symbol instead.
                if (!isDefinition) {
                    const localDefinition = this.resolver.resolveDefinition(
                        candidateDocument,
                        new vscode.Position(
                            candidate.startPosition.row,
                            candidate.startPosition.column,
                        ),
                        lookupName,
                    );
                    if (localDefinition && !targetDefinitions.has(definitionKey(localDefinition))) {
                        continue;
                    }
                }

                if (seen.has(key)) continue;
                seen.add(key);
                locations.push(location);
            }
        }

        return locations.sort((left, right) =>
            left.uri.fsPath.localeCompare(right.uri.fsPath) ||
            left.range.start.line - right.range.start.line ||
            left.range.start.character - right.range.start.character);
    }

    private async workspaceDocuments(
        current: vscode.TextDocument,
        token: vscode.CancellationToken,
    ): Promise<vscode.TextDocument[]> {
        if (current.isUntitled || !vscode.workspace.getWorkspaceFolder(current.uri)) {
            return [current];
        }

        const uris = await vscode.workspace.findFiles(SOURCE_GLOB, EXCLUDE_GLOB);
        const documents: vscode.TextDocument[] = [];
        const seen = new Set<string>();
        const add = (document: vscode.TextDocument): void => {
            const key = document.uri.toString();
            if (seen.has(key)) return;
            seen.add(key);
            documents.push(document);
        };
        add(current);

        for (const uri of uris) {
            if (token.isCancellationRequested) break;
            if (seen.has(uri.toString())) continue;
            try {
                add(await vscode.workspace.openTextDocument(uri));
            } catch {
                // Files that disappear during a workspace search are skipped.
            }
        }
        return documents;
    }
}
