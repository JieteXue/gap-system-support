# Definition Panel Design

Status: implemented as a cursor-following right-hand pane. The original
recursive-tooltip proposal was superseded by the requested simpler interface.
Actual VS Code extension interaction testing remains user-led.

The pane now uses a contextual **GAP Info** layout, inspired by the sections,
source navigation, and pause controls in the
[official Lean 4 Infoview manual](https://github.com/leanprover/vscode-lean4/blob/master/vscode-lean4/manual/manual.md#infoview).
No Lean proof-state, expected-type, or widget execution machinery is emulated.

## Interaction

- Keep native Hover, Go to Definition, and Find All References.
- Open one reusable read-only pane beside the editor via its title icon,
  the native Hover link, or `GAP: Show Definition Panel`.
- Preserve source-editor focus and follow its insertion cursor/selection.
- Show the complete AST-delimited definition with syntax highlighting,
  comments, category, and source navigation.
- Retain ambiguous origins in a selector rather than guessing one.
- Click identifiers to navigate to real definitions without tooltip layers.
- Show collapsible local context, current-line messages, and file messages.
- Offer pause/resume, refresh, source location, and native reference Peek.
- Do not expand nested tooltips or add pinning/history controls.

The Hover entry carries the hovered occurrence's position, so opening it does
not accidentally resolve the editor's unrelated insertion cursor. Later editor
selection changes resume following. Focusing the webview leaves the current
definition intact; switching to another GAP editor resolves that editor, while
a non-GAP editor clears the content.

Unchanged sections retain DOM identity, scroll positions, text selection, and
fold state. Debounced loading keeps the displayed layout but disables navigation
from obsolete data. Pausing freezes the occurrence; source edits mark it stale.

## Reuse And Source Mapping

`GAPHoverProvider.resolveSymbol` is presentation-independent and shares the
existing definition resolver, alias/read-chain handling, caller-input tracing,
and help lookup. `DefinitionPreviewService` loads definitions through the
resolver's shared open-document/file cache.

`GAPDefinitionResolver.localContext` reuses the cached lexical event model rather
than maintaining another completion scanner. It reports at most 128 visible
parameter/local bindings, excludes record entries, and preserves nested shadowing.
`inspectionContext` consumes already-published VS Code diagnostics, prioritizing
current-line messages and bounding display to 200 entries. Published diagnostic
changes refresh the pane without a cursor movement or a second syntax check.

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

An additional 64-entry source-definition cache shares excerpt text and highlight
tokens across cursor offsets, calls, and aliases that reach the same definition.
Its key includes source URI/version, declaration location, and resolver revision;
the source text must also match. Alias titles and comments remain occurrence
specific. Invalidating or closing the pane clears both preview caches.

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

Identifier-navigation messages use issued preview/token identities and resolve
their server-owned positions only on click. Local binding and diagnostic actions
use issued indices and validate the origin snapshot. Reference queries reuse
the registered provider, and obsolete asynchronous results cannot open Peek.

Opening a source document rechecks the request epoch and source snapshot after
asynchronous document loading, before showing an editor. A reopened pane gets a
new session identity; messages from a closed pane cannot act on its replacement.

## Verification

Automated coverage includes full definition boundaries, original CRLF/Unicode
source, highlight categories, nested aliases, alternate return origins,
installation calls, built-ins, cursor debounce, editor switching, unsaved edits,
safe source navigation, ticket expiry, CSP, and disposal.

Additional coverage checks lexical context, nested shadowing, captured bindings,
clickable definition tokens, pause/resume/refresh, diagnostic publication,
binding/message navigation, and stale asynchronous reference queries.

Isolated renderer checks are not actual VS Code extension tests. Actual extension
interaction testing remains user-led in the default VS Code window. Completing
this feature does not automatically package, install, or release a VSIX.

### VS Code Acceptance Checklist

1. Open a GAP workspace and use the editor-title icon, native Hover link, and
   command palette to open the same pane. Check that source-editor focus remains.
2. Move through `ME`, `ME.Compare`, and fields of a returned record. Confirm each
   selected segment and ambiguous-origin chooser matches Go to Definition.
3. Verify `group` shows its own binding, while `Group` opens built-in help;
   repeat with parameters, record fields, and a lowercase user-defined function.
4. Check complete definitions, real line numbers, indentation guides, horizontal
   scrolling, light/dark themes, a narrow pane, and copied multiline source.
5. Click definition identifiers, local bindings, and diagnostics; invoke reference
   Peek and verify aliases appear in references to the original definition.
6. Pause, move the cursor, edit an imported source, refresh, and resume. Stale
   content must not jump using old offsets. Rapid movements must settle on the
   final occurrence without resetting unchanged sections.
7. Close and reopen the pane; switch between GAP and non-GAP editors. Check
   diagnostics update without cursor movement and old actions cannot navigate.
