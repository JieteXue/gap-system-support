# Definition And Reference Navigation

The extension provides static definition and reference navigation through the
native VS Code APIs. It uses the existing Tree-sitter parser and does not start
or evaluate a GAP process.

## Editor Behavior

- **Go to Definition** (`F12`) resolves a symbol use to its definition,
  declaration, or available implementations.
- **Find All References** (`Shift+F12`) finds statically recognizable uses in
  the current workspace.
- `Command+click` on macOS or `Ctrl+click` on Windows/Linux follows a symbol
  use to its definition.
- Clicking a definition that has other references opens the native Peek view.
  The selected definition is omitted from the Peek results.
- Clicking a definition with no other references navigates to that definition
  without opening an empty Peek view.

When a declaration has multiple implementations, such as an operation with
several installed methods, all statically recognizable candidates are returned
and VS Code presents its normal location picker.

## Recognized Symbols

Navigation covers lexical variables, parameters, functions, record/component
paths, GAP declaration calls, installation calls, and binding calls. Complete
qualified paths are preserved, so names such as `A.Print` and `B.Print` do not
share reference results.

See [Definition Navigation Coverage](definition-navigation-coverage.md) for the
detailed construct list and static-analysis limits.

## Cross-File Resolution

Literal `Read("path")` chains are followed in source order, including nested
and circular chains. Open documents take precedence over their saved content.
For computed loaders such as `Read(Concatenation(...))`, a guarded workspace
fallback can resolve top-level symbols from `.g`, `.gd`, `.gi`, and `.gap`
files.

Workspace fallback is intentionally static. It does not execute package
initialization, evaluate computed names, or reproduce runtime method dispatch.

## Peek And Reference Rules

Reference collection uses the same symbol classifier as definition navigation:

- lexical scope and shadowing are preserved;
- declaration and implementation sites can be included or excluded according
  to the VS Code request;
- comments and ordinary strings are excluded;
- the selected occurrence is omitted from Peek results;
- qualified record and component paths are matched by their complete name.

## Performance

Hover, definition, and reference providers share one definition resolver.
Each document model contains source lines, line offsets, scalar definition
events, and lexical scope offsets. Unchanged models remain reusable even when
the parser evicts and recreates their native syntax trees.

Workspace fallback builds one symbol index per workspace, not one scan per
symbol name. Indexes expire after five seconds and are invalidated on text
edits, saves, file creation/deletion/renaming, and document closure. Current-file
exclusion happens at lookup time so the same index serves different documents.
Global alias bindings are indexed as cursor-sensitive histories, including
bindings imported by literal `Read` calls.

Reference indexes retain immutable names and positions instead of native
syntax nodes, and qualified references are indexed by their leaf name before
checking definition identity. Document and workspace indexes use bounded LRU
caches. Disk files are checked by modification time and size; unchanged cache
entries need neither another content read nor another parse. Open document
versions take priority over disk signatures.

Return-value tracing uses the shared source loader, request-local scope and
record-field indexes, and memoized definition lookups. It temporarily copies
syntax trees to keep recursive cross-file nodes valid during parser eviction
and releases those copies when the request ends. Providers retain scalar
cursor context before resolution so their ranges do not depend on an evicted
tree.

Limits in `src/limits.ts` bound document size, cache sizes, and scanned content.
When a limit is reached, the provider returns no static result rather than
blocking the editor.

## Verification

The automated suite covers:

- same-file and cross-file definitions;
- `.gd` declarations and `.gi` implementations;
- multiple installed methods;
- lexical shadowing;
- nested `rec(...)` fields and dotted/component paths;
- Peek behavior with and without references;
- reference exclusion rules and workspace cache reuse;
- Hover resolution that shares the definition model.
- cache invalidation for unsaved edits, new/deleted files, closure, and expiry;
- shared parsing and workspace scans, and tracing beyond the parser cache size.

Run the complete suite with:

```bash
npm test
```

For manual VS Code testing, build a VSIX with
`npx @vscode/vsce package` or launch an Extension Development Host with `F5`.
