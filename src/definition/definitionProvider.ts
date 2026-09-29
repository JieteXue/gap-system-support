/** Provide native Go to Definition for GAP user-defined functions. */

import * as vscode from 'vscode';
import { isParserReady, getDocumentTree } from '../parser/gapParser';
import { GAPDefinitionResolver } from '../hover/definitionResolver';
import { symbolNameNodeAt } from '../shared/functionName';

export class GAPDefinitionProvider implements vscode.DefinitionProvider {

    private resolver: GAPDefinitionResolver;

    constructor(completionPath: string) {
        this.resolver = new GAPDefinitionResolver(completionPath);
    }

    onDocumentClosed(uri: vscode.Uri): void {
        this.resolver.onDocumentClosed(uri);
    }

    provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
    ): vscode.Definition | vscode.DefinitionLink[] | undefined {
        if (!isParserReady()) return undefined;

        // Only function and GAP symbol names qualify.
        const offset = document.offsetAt(position);
        if (token.isCancellationRequested) return undefined;
        const tree = getDocumentTree(document);
        const node = symbolNameNodeAt(tree.rootNode, offset);
        if (!node) return undefined;

        const resolved = this.resolver.resolveDefinitions(document, position, node.text);
        if (resolved.length === 0) return undefined;

        const first = resolved[0];
        const firstSameDocument =
            first.filePath !== '' &&
            (process.platform === 'win32'
                ? first.filePath.toLowerCase() === document.uri.fsPath.toLowerCase()
                : first.filePath === document.uri.fsPath);
        if (resolved.length === 1 &&
            firstSameDocument &&
            position.line === first.row &&
            position.character >= first.column &&
            position.character <= first.column + node.text.length) {
            const uri = first.filePath === '' ? document.uri : vscode.Uri.file(first.filePath);
            const zeroCharacter = position.character === first.column
                ? first.column + node.text.length
                : first.column;
            return [{
                targetUri: uri,
                targetRange: new vscode.Range(
                    new vscode.Position(first.row, first.column),
                    new vscode.Position(first.row, first.column + node.text.length),
                ),
                targetSelectionRange: new vscode.Range(
                    new vscode.Position(first.row, zeroCharacter),
                    new vscode.Position(first.row, zeroCharacter),
                ),
            } as vscode.LocationLink];
        }

        return resolved.map(item => {
            const sameDocument =
                item.filePath !== '' &&
                (process.platform === 'win32'
                    ? item.filePath.toLowerCase() === document.uri.fsPath.toLowerCase()
                    : item.filePath === document.uri.fsPath);
            const uri = sameDocument || item.filePath === '' ? document.uri : vscode.Uri.file(item.filePath);
            return new vscode.Location(
                uri,
                new vscode.Range(
                    new vscode.Position(item.row, item.column),
                    new vscode.Position(item.row, item.column + node.text.length),
                ),
            );
        });
    }
}
