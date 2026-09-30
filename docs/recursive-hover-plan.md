# Definition Panel Design

Status: implemented as a cursor-following right-hand pane. The original
recursive-tooltip proposal was superseded by the requested simpler interface.
Actual VS Code extension interaction testing remains user-led.

## Interaction

- Keep native Hover, Go to Definition, and Find All References.
- Open one reusable read-only pane beside the editor via its title icon,
  the native Hover link, or `GAP: Show Definition Panel`.
- Preserve source-editor focus and follow its insertion cursor/selection.
- Show the complete AST-delimited definition with syntax highlighting,
  comments, category, and source navigation.
- Retain ambiguous origins in a selector rather than guessing one.
- Do not expand nested tooltips or add pinning/history controls.

The Hover entry carries the hovered occurrence's position, so opening it does
not accidentally resolve the editor's unrelated insertion cursor. Later editor
selection changes resume following. Focusing the webview leaves the current
definition intact; switching to another GAP editor resolves that editor, while
a non-GAP editor clears the content.

## Reuse And Source Mapping

`GAPHoverProvider.resolveSymbol` is presentation-independent and shares the
existing definition resolver, alias/read-chain handling, caller-input tracing,
and help lookup. `DefinitionPreviewService` loads definitions through the
resolver's shared open-document/file cache.

`definitionExcerpt` exposes syntax-tree boundaries. Preview text is the original
source slice, preserving CRLF, Unicode, delimiters, and indentation. Highlight
tokens are immutable scalar ranges from the existing syntax query; the renderer
never guesses offsets by searching for a repeated spelling. Query position
ranges constrain highlighting to the displayed definition.

## Performance And Lifecycle

Selection changes are debounced by 140 ms; only the final position is resolved.
No symbols inside the displayed definition are eagerly resolved. Cached results
are bounded to 64 entries with a five-second TTL and keys including URI,
document version, position, and resolver revision. Highlight output is bounded
to 8,000 tokens and Hover entry tickets to 128. Existing file-size and inference
work limits continue to apply.

Unsaved edits, file saves, close/create/delete/rename events, and external GAP
file changes invalidate snapshots. The current editor position is re-resolved
instead of applying old offsets to new text. The file watcher and editor
listeners exist only while the pane is open. Closing the pane cancels the timer
and releases previews, cache, watcher, and listeners; extension disposal also
releases the compiled highlight query.

## Safety

The local webview uses a restrictive CSP and nonce-bound script. Source and
comments are rendered with text nodes, never HTML. Native Hover trusts only
specific entry/navigation commands. Entry links carry bounded, unguessable
tickets for server-owned source positions, not client-supplied paths.

Source-navigation messages must match the current session/epoch and an issued
candidate index. The host uses its own preview URI and source coordinates,
validates freshness, and rejects obsolete or forged requests. Neither renderer
evaluates GAP.

## Verification

Automated coverage includes full definition boundaries, original CRLF/Unicode
source, highlight categories, nested aliases, alternate return origins,
installation calls, built-ins, cursor debounce, editor switching, unsaved edits,
safe source navigation, ticket expiry, CSP, and disposal.

Isolated renderer checks are not actual VS Code extension tests. The local
VSIX is intended for user-led testing in the default VS Code window, without
depending on an Extension Development Host debugger.
