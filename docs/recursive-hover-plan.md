# Recursive Definition Hover Plan

Status: preparation only; nested Hover is not implemented.

## Goal

After inspecting a symbol's definition, hovering a resolvable symbol inside
that definition should reveal its own definition. The same operation should
continue across files, aliases, returned fields, and known parameter inputs
without losing the original inspection context.

Example path:

```text
character.generators
  -> MakeSignCharacter's generators record entry
  -> the generators parameter
  -> a caller's local generators assignment
```

Each step must resolve at the displayed occurrence's real source location.
Equal names alone are not sufficient evidence that two symbols are related.

## API Boundary

Checked against the public API matching local VS Code 1.139.1, commit
`04c0d99f4fb0d8afe6ce4f0c58e31e183ac3e4b1`, and the project's VS Code types.
`Hover` exposes Markdown contents and an editor range; `HoverProvider` receives
a source document position. `MarkdownString` supports highlighted code blocks,
trusted command links, and a safe HTML subset, but no per-token Hover callbacks
or embedded source-editor contract.

Reference: [VS Code API source at the checked commit](https://github.com/microsoft/vscode/blob/04c0d99f4fb0d8afe6ce4f0c58e31e183ac3e4b1/src/vscode-dts/vscode.d.ts).

Consequently, a stable public extension API cannot make arbitrary tokens inside
the existing native Markdown tooltip request another native tooltip just by
moving the mouse. Enabling HTML does not supply that interaction contract.
Do not inject scripts or manipulate VS Code workbench DOM to emulate it.

## Recommended Experience

Retain the current native Hover and add one explicit entry command/link to a
read-only definition inspection webview. Once opened, its source tokens support
actual mouse-triggered nested previews. The first entry needs a click; deeper
inspection does not need to navigate away or click through every definition.
This is a deliberate interaction tradeoff, not native hover-in-hover.

Native Peek Definition remains a low-cost alternative for inspecting actual
source and using the existing Hover provider in its editor. It is not the
same as a recursive floating-tooltip stack.

The proposed webview should provide:

- The complete AST-delimited definition and source location.
- Nested previews anchored to the selected token, retaining parent previews.
- Segment-specific resolution of roots, intermediate records, and leaf fields.
- A source-location chooser when several origins are possible.
- Pin, close, back, forward, and open-source actions with named tooltips.
- Escape to close the deepest preview; keyboard focus can inspect tokens too.
- Stable behavior while the pointer moves from parent token into child preview.
- Theme-aware, constrained widths and scrollable long definitions.
- No guessed field origin for unknown parameters or dynamic selectors.

Keep normal editor Hover, Go to Definition, and Find All References unchanged.

## Shared Data Model

Introduce a renderer-independent definition preview model with:

- Source URI, document version, exact excerpt range, and source text.
- Symbol category, comment text, and all candidate definition identities.
- Immutable tokens carrying source ranges and classification.
- A revision/request identifier for detecting invalidated views and stale replies.

Extend AST-delimited extraction to return the excerpt range together with its
text. Preserve the current semicolon, nested-record, and neighboring-definition
rules. Never recover source positions by searching for token text in a formatted
snippet: repeated names, indentation, CRLF, and Unicode make that ambiguous.

Extract presentation-independent symbol resolution from the native Hover
provider only where the new consumer needs it. Both renderers must use the
existing shared resolver, source loader, alias history, and value tracing.
Reuse the existing symbol classifier and syntax queries for token generation.
No second workspace scanner or independent inference engine is needed.

Webview messages should identify a session, preview, token, and request.
The extension owns the corresponding document positions and validates the
token before resolving it. The webview must not supply arbitrary file paths,
commands, source text, or expression strings to execute.

## Performance And Lifetime

Resolve only the hovered token, with a short dwell delay; do not expand every
symbol in a definition eagerly. Cancel pending work when the pointer or focus
moves and discard replies from obsolete requests.

Start with a maximum of eight preview levels, 32 history entries, and a bounded
64-entry preview cache per session. Put adjustable limits in `src/limits.ts`.
Existing file-size, expression-work, and recursion limits still apply.

Cache keys must include source URI/version, token position, and resolution
revision. Workspace changes invalidate previews, including results influenced
by imported aliases or caller arguments. Refresh changed source before reusing
old token positions; never silently resolve an old offset against new text.

Store scalar ranges and token data, not long-lived native SyntaxNodes. Any
temporary tree copies must be released before asynchronous UI waits. Closing
the panel disposes subscriptions, pending requests, history, and cached previews.

## Safety

Use a restrictive webview CSP, nonce-bound local scripts, and no remote scripts.
Escape source and comment text; avoid treating documentation or GAP strings
as trusted HTML. Allowlist the native Hover entry command instead of granting
general command trust.

Messages can request inspection or navigation only for token identities already
issued to that session. Invalid, obsolete, out-of-range, and cross-session
messages must be rejected. Neither renderer evaluates GAP.

## Implementation Order

1. Verify the interaction tradeoff and prototype parent-to-child pointer/focus
   behavior in an actual Extension Development Host.
2. Add source-range-aware extraction and immutable preview models, preserving
   existing Hover output and symbol resolution behavior.
3. Implement the minimal panel/session/message protocol and one nested level.
4. Add deeper previews, ambiguity selection, history, pinning, and bounded caches.
5. Add lifecycle, security, and source-mapping regressions; package a local VSIX
   for user-led extension testing before publishing.

## Acceptance Checks

- The reported `time_axes.g` parameter field resolves to `characters.g`, and
  symbols in that displayed definition can be inspected again.
- Alias roots, intermediate fields, and leaf functions resolve independently.
- Multiple parameter inputs remain distinct candidates; unrelated same-named
  functions and shadowed locals are excluded.
- Source mapping works with repeated identifiers, CRLF, Unicode, and multiline
  definitions; neighboring definitions do not appear accidentally.
- Pointer movement into a child does not dismiss its parents prematurely.
- Circular relationships, rapid pointer movement, and parser eviction terminate
  safely without showing stale content.
- Unsaved edits and file creation/deletion/rename invalidate affected views.
- Malicious source strings and forged webview messages cannot execute commands.
- Full `npm test` continues to pass; isolated renderer tests are not presented
  as substitutes for actual VS Code extension testing.

## Preparation Progress

- Upstream fetched and merged; conflicts resolved while preserving newer
  navigation, caching, and parameter-field fixes.
- Local VS Code public Hover API checked.
- Source mapping, interaction boundary, reuse, limits, and acceptance cases defined.
- Prototype and feature implementation remain pending.
