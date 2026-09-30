/** Source-owned context and diagnostic locations for the information pane. */
import * as vscode from 'vscode';
import * as path from 'path';
import { GAPDefinitionResolver, LocalContext } from './definitionResolver';
import { INSPECTION_MAX_DIAGNOSTICS } from '../limits';

export interface InspectionDiagnostic {
    message: string;
    severity: number;
    source?: string;
    row: number;
    column: number;
    endRow: number;
    current: boolean;
}

export interface InspectionContext {
    uri: string;
    sourceLabel: string;
    row: number;
    column: number;
    local: LocalContext | null;
    diagnostics: InspectionDiagnostic[];
    diagnosticCount: number;
}

export function inspectionContext(
    document: vscode.TextDocument, position: vscode.Position, resolver: GAPDefinitionResolver,
): InspectionContext {
    const diagnostics = vscode.languages.getDiagnostics(document.uri)
        .slice()
        .sort((a, b) =>
            Number(b.range.start.line <= position.line && b.range.end.line >= position.line) -
                Number(a.range.start.line <= position.line && a.range.end.line >= position.line) ||
            Math.abs(a.range.start.line - position.line) - Math.abs(b.range.start.line - position.line) ||
            a.severity - b.severity || a.range.start.line - b.range.start.line);
    return {
        uri: document.uri.toString(),
        sourceLabel: path.basename(document.uri.fsPath) || 'Untitled',
        row: position.line, column: position.character,
        local: resolver.localContext(document, position),
        diagnosticCount: diagnostics.length,
        diagnostics: diagnostics.slice(0, INSPECTION_MAX_DIAGNOSTICS).map(item => ({
            message: item.message, severity: item.severity, source: item.source,
            row: item.range.start.line, column: item.range.start.character,
            endRow: item.range.end.line,
            current: item.range.start.line <= position.line && item.range.end.line >= position.line,
        })),
    };
}
