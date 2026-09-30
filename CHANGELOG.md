# Changelog

## Unreleased

1. Resolve fields of function parameters from statically recognizable workspace callers, including wrapper calls and `for` list element bindings; match callee definition identities to exclude unrelated functions
2. Add a cursor-following, syntax-highlighted definition panel to the right, opened from the editor-title icon, native Hover, or the command palette; refresh unsaved edits and imported origins without recursive tooltip layers
3. Make the pane contextual and interactive with lexical locals, clickable definition tokens, native reference Peek, published diagnostics, collapsible sections, pause/resume, and stable content during cursor updates
4. Add source line numbers, a sticky code gutter, and indentation guides to the information pane; preserve syntax spans, navigation identities, and copied source text
5. Match built-in help symbols case-sensitively so variables such as `group` are not mistaken for `Group`; keep normalized documentation search independent
6. Reuse definition highlighting across occurrences and aliases, reject stale asynchronous source navigation, and isolate reopened pane sessions

## 0.4.1 - 2026-09-30

1. Resolve global aliases such as `ME := MagneticEquivalence` across source files, with segment-specific Hover and reverse references through renamed roots
2. Trace returned record fields through assignments, forwarding functions, parameters, and list element origins for Hover and definition/reference navigation
3. Show complete syntax-tree-delimited definitions in Hover, including function bodies, nested records, and installation calls
4. Share navigation resolution models, index workspace symbols once per cache lifetime, bound caches, and avoid repeated disk reads; preserve node safety during parser eviction

## 0.4.0 - 2026-09-29

1. Expand Go to Definition across lexical symbols, qualified record/component paths, GAP declarations, bindings, installations, and multiple method implementations
2. Add workspace Find All References and native Peek behavior with lexical scope, complete qualified-name matching, selected-occurrence exclusion, and direct navigation for definitions without references
3. Add static Hover categories, built-in help summaries, language keyword/operator/punctuation descriptions, cross-file guarded lookup, and syntax-highlighted GAP snippets
4. Cache parsed files, workspace symbol/reference indexes, help lookups, and documentation summaries to keep repeated editor requests responsive

Special thanks to [@JieteXue](https://github.com/JieteXue) for contributing these features.

## 0.3.5

1. Add GAP syntax checking tool and integrate with diagnostics
2. Add the book short name to each `search_gap_help` result entry
3. Add GAP installation instructions to the welcome page walkthrough
4. Update READMEs to list all four language model tools

## 0.3.4

1. Add Go to Definition and Peek Definition support through VS Code's DefinitionProvider API

## 0.3.3

1. Update `README.md` and `README.zh-cn.md`

## 0.3.2

1. Add language model tools for GAP help: `search_gap_help`, `list_gap_books`, and `gap_resolve_link` (referenced as `#gapSearch`, `#gapBooks`, and `#gapResolveLink` in chat)
2. `search_gap_help`: search the GAP help index and return entry locations (absolute path, target line, total lines), with book filtering and paging
3. `list_gap_books`: list all GAP help books by short name
4. `gap_resolve_link`: resolve a relative link inside a help file to the target file's absolute path, target line, and total lines

## 0.3.1

1. Add tree-sitter syntax diagnostics to GAP extension
2. Add `.gap` file association to GAP extension
3. Add hover on function names
4. Optimize the structure of files under `src/`

## 0.3.0

1. Integrate the [GAP Help extension](https://github.com/lstflian/gap-help), including search and documentation viewer.

## 0.2.2

1. Fix record members and call option names being recolored as variables
2. Map the `property` capture to `enumMember`

## 0.2.1

1. Incremental semantic highlighting for large files, with full fallback for safety
2. Semantic token type `enumMember` for record entries and selectors
3. Fix TextMate grammar for `'''` character literals

## 0.2.0

1. Scoped completion for variables, parameters and user defined functions visible at the cursor
2. Completion for user defined functions in other GAP files loaded via `Read`

## 0.1.0

1. Refine semantic highlighting

## 0.0.2

1. Split third-party notices out of `LICENSE` into `THIRDPARTYNOTICES.md`
2. Add author to `package.json`

## 0.0.1

1. Initial release
2. Semantic and syntax highlighting for GAP files (`.g`, `.gi`, `.gd`)
3. Code folds
4. Code completion for constants, keywords, statement snippets and GAP functions
5. Run GAP file in a terminal, with new or reuse terminal modes
6. Configure GAP command line options through a quick pick
7. Generate and reset completion data from a local GAP installation
8. Path conversion for WSL and Git Bash terminals
