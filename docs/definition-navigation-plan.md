# GAP Definition Navigation Plan

## Goal

Improve the existing VS Code extension so that GAP users can navigate from a
symbol use to its declaration or implementation, while keeping the current
extension scope:

- VS Code only
- static analysis only
- Tree-sitter based
- no separate language server in this phase
- no attempt to reproduce GAP's complete runtime method dispatch

The first deliverable is a reliable Definition Provider. Other language
features should not be redesigned as part of this work.

## Current Baseline

The repository already contains a mature implementation that should be
extended rather than replaced.

### Existing infrastructure

- `src/parser/gapParser.ts`
  - loads `wasm/tree-sitter-gap.wasm`
  - maintains per-document syntax trees
  - supports incremental parsing and document eviction
- `src/definition/definitionProvider.ts`
  - registers the native VS Code Definition Provider
  - gates requests to function-like identifiers
  - returns `Location` or `LocationLink`
- `src/hover/definitionResolver.ts`
  - collects function definition events from Tree-sitter query captures
  - understands local function scopes
  - resolves definitions by scanning backward
  - follows `Read("...")` chains
  - caches parsed files and document events
- `src/shared/functionName.ts`
  - currently accepts function call callees and assignments whose right side
    is a function/lambda
- `queries/completion.scm`
  - already identifies function definitions and `Read` calls
- `test/lib/definition/definition.test.js`
  - covers same-file functions, nested functions, `Read` chains, locations,
    cancellation, untitled documents, and negative cases

### Current limitation

The existing resolver is intentionally function-oriented. It does not yet
model GAP declarations and installations as first-class symbols, for example:

```gap
DeclareGlobalFunction("MyFunction");
InstallGlobalFunction(MyFunction, function(x)
  ...
end);
```

or:

```gap
DeclareOperation("Size", [IsObject]);
InstallMethod(Size, [IsList], function(x)
  ...
end);
```

## Product Scope

### Phase 1: Definition navigation

Support:

1. Existing local and `Read()`-chain function navigation.
2. `DeclareGlobalFunction("Name")`.
3. `InstallGlobalFunction(Name, ...)`.
4. `BindGlobal("Name", ...)`.
5. `DeclareOperation("Name", ...)`.
6. `InstallMethod(Name, ...)`.
7. `DeclareAttribute("Name", ...)` and its method implementations where the
   syntax can be identified without runtime evaluation.
8. Multiple locations for symbols with multiple methods.
9. `.gd` declarations and `.gi` implementations.
10. Workspace-local files and files reached through existing `Read()` logic.

### Explicitly out of scope for Phase 1

- Exact runtime method selection based on GAP filters.
- Full GAP type inference.
- Executing GAP to resolve a symbol.
- Complete package dependency resolution.
- Cross-editor Language Server support.
- References, rename, full semantic completion, and code actions.

When a symbol has multiple possible `InstallMethod` locations, the provider
should return all useful candidates and let VS Code show the picker. It should
not silently choose an arbitrary method.

## Technical Design

### 1. Preserve the current parser and cache layers

Do not replace `gapParser.ts`, the existing Tree-sitter WASM, or the document
cache. The new behavior should use the same syntax trees and lifecycle hooks.

### 2. Extend the definition event model

Extend the event model in `src/hover/definitionResolver.ts` or extract it into
a focused module if the file becomes too large.

The current event model should evolve from:

```text
function definition
Read call
```

to:

```text
symbol declaration
symbol implementation
function/local definition
Read call
```

Each symbol event should contain:

- symbol name
- symbol kind
- declaration or implementation role
- source range
- enclosing scope
- source file
- event offset
- optional method metadata

### 3. Add Tree-sitter query captures where useful

Prefer explicit query captures in `queries/completion.scm` or a dedicated
definition query over text scanning. The query must be tested against the
actual AST shape produced by the pinned GAP grammar.

Potential capture categories:

```text
definition.global-function
definition.operation
definition.method
definition.attribute
definition.declaration
definition.name
```

If the grammar does not expose enough structure for a declaration directly,
use a small AST helper around the relevant call node. Do not introduce
regular-expression parsing as the primary implementation.

### 4. Broaden identifier gating

Replace the function-only assumptions in
`src/shared/functionName.ts` with a symbol-use classifier. It should identify:

- call callees
- names in `Declare...` and `Install...` forms
- names in relevant assignment forms

It must continue rejecting:

- local variables
- function parameters
- record fields
- keywords
- arbitrary identifiers that are not symbol uses

### 5. Define deterministic result ordering

For a single result, use this preference:

1. implementation in the current document
2. implementation reached through the current file's `Read()` chain
3. implementation in the current workspace
4. declaration in the current workspace
5. other indexed locations

For multiple methods, preserve all candidates. Do not apply a fake
type-based ranking in Phase 1.

### 6. Keep the VS Code API boundary small

`src/definition/definitionProvider.ts` should remain responsible for:

- cursor position and document conversion
- cancellation
- conversion to VS Code `Location` / `LocationLink`

Symbol collection and resolution should remain testable without starting a
full VS Code extension host.

## Implementation Stages

### Stage A: Grammar and AST reconnaissance

- Add small GAP fixtures for each target construct.
- Print or inspect Tree-sitter node shapes.
- Confirm whether declarations and installations are represented as regular
  calls, special nodes, or both.
- Decide query captures based on observed nodes.

Deliverable: fixture set and a short AST mapping in test comments or docs.

### Stage B: Symbol event extraction

- Add declaration and implementation events.
- Keep current function and `Read()` behavior unchanged.
- Add unit-level tests for event extraction if practical.

Deliverable: resolver can identify all target events in a single file.

### Stage C: Cross-file resolution

- Associate declaration and implementation names.
- Reuse existing `Read()` path resolution and file cache.
- Add `.gd`/`.gi` fixtures.
- Support multiple implementations without losing current single-result
  behavior for ordinary functions.

Deliverable: cross-file definition navigation.

### Stage D: Provider integration

- Broaden cursor gating.
- Return a single `Location` where unambiguous.
- Return multiple locations for multiple methods.
- Preserve current self-definition `LocationLink` behavior.

Deliverable: end-to-end VS Code Definition Provider behavior.

### Stage E: Regression and packaging

- Run TypeScript compilation.
- Run the existing test suite.
- Add definition-navigation cases to
  `test/lib/definition/definition.test.js`.
- Build a VSIX and manually test in an Extension Development Host.

## Test Matrix

Required fixtures:

1. Local `Name := function(...)`.
2. Nested local function.
3. `Read()` of a `.g` file.
4. `.gd` declaration plus `.gi` implementation.
5. `DeclareGlobalFunction` plus `InstallGlobalFunction`.
6. `BindGlobal`.
7. One operation with one method.
8. One operation with two methods.
9. Attribute declaration and method.
10. Comments and strings containing declaration-like text.
11. Incomplete syntax while editing.
12. Missing `Read()` target.
13. Circular `Read()` chain.
14. Untitled document behavior.
15. System/built-in symbol with no user definition.

The negative cases are important: a definition provider must not fabricate a
location merely because an identifier has a familiar name.

## Risks

### GAP method dispatch

Static code cannot always determine which `InstallMethod` wins at runtime.
Phase 1 returns candidates instead of pretending to know the runtime result.

### Grammar coverage

The exact AST shape must be confirmed from the pinned grammar. Query changes
should be driven by fixtures, not assumptions about GAP syntax.

### File loading

`Read()` paths can be dynamic or conditional. Existing static path resolution
should remain the source of truth; unresolved paths should produce no result,
not an error or guessed location.

### Performance

The existing resolver already has caches and limits. New symbol events should
be included in those caches and must not trigger full workspace rescans for
every cursor request.

## Completion Criteria

Phase 1 is complete when:

- existing tests remain green;
- all required fixtures pass;
- ordinary function navigation has no regression;
- declarations and implementations can be navigated across `.gd`/`.gi`;
- multiple methods produce multiple valid candidates;
- incomplete code does not crash the extension;
- a VSIX can be built and installed locally;
- no runtime GAP process is required for navigation.

## Git Workflow

- Work only on the personal fork `JieteXue/gap-system-support`.
- Keep `upstream` pointing to `lstflian/gap-system-support`.
- Use focused commits.
- Do not open or push changes to the upstream repository.
- The first commit in this fork is documentation only.
