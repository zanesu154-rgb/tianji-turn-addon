# CLAUDE.md — LFMC Project Engineering Guidelines

## 1. Project Identity

You are working on **LFMC (Localizator for MCBE)**, a Minecraft Bedrock Edition localization and translation tool.

Your role is an implementation engineer responsible for:
- Investigating localization extraction and transformation defects.
- Analyzing JavaScript source code and runtime behavior.
- Implementing minimal, evidence-based fixes.
- Maintaining compatibility with existing translation files and generated scripts.
- Providing reproducible test results and implementation reports.

The project is safety-oriented. Preserving the original add-on's behavior is more important than maximizing extraction coverage.

**Core principle: Never break valid source code in pursuit of extracting more translatable text.**

## 2. Task Scope: GitHub Issue Is the Contract

Tasks are assigned through GitHub Issues.

Before making any changes:

1. Read the complete assigned Issue, including its acceptance criteria, evidence, comments, and linked investigation reports.
2. Identify the exact defect and its expected behavior.
3. Inspect the relevant source code and call chains.
4. Identify the fixed baseline commit specified by the Issue.
5. Check existing repository instructions and relevant historical fixes.
6. Establish which files and behaviors are within scope.

Do not assume that similarly named defects have the same root cause.

### Strict scope restrictions

- Only modify files necessary to resolve the assigned Issue.
- Do not fix unrelated bugs opportunistically.
- Do not modify translation keys, extraction rules, or pipeline behavior unless explicitly required.
- Do not refactor unrelated modules.
- Do not modify the knowledge base or other Issues without authorization.
- Do not start another CV task or expand into another Issue automatically.

If an adjacent defect is discovered, document it and report it separately.

If the requested fix requires expanding the original scope, stop and explain why before proceeding.

## 3. Baseline and Compatibility

Every fix must be evaluated against the specified fixed baseline.

Unless the Issue explicitly states otherwise:

- Treat the designated `main` commit as the behavioral reference.
- Do not assume the current working branch is an unchanged copy of `main`.
- Record the baseline commit SHA.
- Compare generated artifacts against baseline outputs.
- Preserve existing language keys and translations unless the Issue explicitly requires changes.

For localization transformations, verify:

- No unintended key additions or deletions.
- No reassignment of existing keys.
- No accidental translation overwrites.
- No unintended ordering changes.
- No loss of formatting codes or placeholders.
- No changes to unrelated BP/RP language files.

A successful build does not automatically mean a safe transformation.

## 4. Source Analysis Requirements

LFMC performs static analysis and transformation of JavaScript.

JavaScript is highly dynamic. Static analysis cannot reliably determine every possible runtime behavior.

Therefore:

**Never treat an inferred object identity, variable purpose, or call-site behavior as a proven fact without sufficient evidence.**

When analyzing source code:

1. Trace the actual data flow.
2. Inspect declarations, assignments, imports, exports, and function boundaries.
3. Distinguish local usage from externally observable usage.
4. Check whether objects escape their original scope.
5. Check whether functions, objects, or properties can be accessed or modified externally.
6. Identify what the transformation actually changes in the generated output.
7. Validate the result through execution or a reproducible probe whenever possible.

### Conservative fallback rules

When static analysis cannot establish a safe transformation:

- Preserve the original expression.
- Do not upgrade an inferred object identity.
- Do not rewrite an Observable to another type based solely on an internal call.
- Do not assume an object's internal usage represents all external usage.
- Do not guess the meaning of dynamic expressions.

In particular, an object escaping through `return`, external assignment, export, or an otherwise unverified closure must not retain an unsafe inferred identity.

For Ore UI and Observable transformations, only rewrite values whose display-only consumption has been sufficiently established.

**Uncertainty must result in conservative fallback, not speculative rewriting.**

## 5. Transformation Safety: Non-Negotiable Requirements

The following are release-blocking defects:

- Generated JavaScript becomes syntactically invalid.
- Previously valid source code becomes unparsable.
- Generated code throws a runtime exception because of the transformation.
- Variables, identifiers, operators, or executable expressions are incorrectly consumed as translation text.
- Observable values receive an incompatible runtime type.
- Existing control flow or gameplay behavior is unintentionally changed.
- Translation parameters, placeholders, or formatting codes are corrupted.

Always preserve:

- Comments.
- Commas and delimiters.
- Template literals.
- String escaping.
- Function and variable scope.
- Import/export semantics.
- Minecraft formatting codes such as `§a`, `§l`, and `§r`.

When modifying JavaScript source, prefer syntax-aware transformations over fragile string insertion or deletion.

After modifying generated JavaScript, perform a syntax validation using the parser or validation mechanism already available in the project.

## 6. Engineering Strategy: Minimal Fix First

Use the following workflow:

### Phase A — Investigation

- Reproduce the original defect on the fixed baseline.
- Identify the exact source of the defect.
- Record the relevant call chain and data flow.
- Determine the smallest responsible code region.

Do not modify code before understanding the root cause.

### Phase B — Test First

Create a minimal regression test reproducing the reported defect.

The test must:
- Run against the fixed baseline and reproduce the original behavior.
- Run against the proposed patch and verify the expected behavior.
- Inspect actual generated output, not merely internal flags.
- Verify that unrelated behavior remains unchanged.

### Phase C — Implementation

- Implement the smallest safe correction.
- Avoid broad refactoring.
- Preserve existing interfaces and data contracts.
- Avoid adding new heuristics without evidence.
- Prefer explicit conservative fallback over speculative inference.

### Phase D — Regression

Run the relevant project tests and historical regression tests.

Compare the modified version with the fixed baseline.

### Phase E — Report

Provide a concise but complete implementation report.

Do not claim a test passed unless it was actually executed.

## 7. Regression Testing and Evidence Classification

Separate verification into four categories.

### A. Targeted regression

The original Issue reproduction must pass.

Every explicitly listed blocking counterexample must be tested.

### B. Historical regression

Preserve existing relevant regression tests.

Do not silently delete, weaken, or rewrite historical assertions simply to obtain a passing test result.

If an old assertion is no longer valid, explain the behavioral contract change and request approval.

### C. Real add-on samples

Test the actual add-on samples identified by the Issue.

Compare generated BP/RP language files and scripts against the fixed baseline.

Record:
- Sample identity and SHA-256.
- Conversion mode.
- Changed files.
- Added, deleted, reassigned, or modified translation keys.
- Runtime replay results.

Do not claim a sample was tested if its exact archive or source revision was unavailable.

### D. Minecraft in-game verification

Node.js tests and generated artifact replay do not establish Minecraft runtime correctness.

Keep the following explicitly marked `UNCOVERED` until actually verified:

- Minecraft UI rendering.
- First display and dynamic refresh.
- Real gameplay behavior.
- Lore and serialized RawMessage compatibility.
- Watchdog behavior.

Never convert an uncovered item into a PASS based on inference.

## 8. Counterexample Classification

Not every theoretical counterexample should block an implementation.

Classify findings according to actual risk.

### BLOCKING

Examples:

- Syntax corruption.
- Runtime exceptions.
- Incorrect variable or expression rewriting.
- Wrong runtime types.
- Broken translation parameters.
- Loss of existing translations.
- Regressions against the fixed baseline.
- Violations of explicitly approved acceptance criteria.

These must be resolved before recommending a PR.

### KNOWN LIMITATION

Examples:

- An unusual JavaScript construct causes a safe extraction miss.
- An unsupported dynamic expression is preserved unchanged.
- An artificial edge case falls outside the current Issue's scope without damaging source code.

Record these findings separately.

Do not expand the current task merely to eliminate every theoretically constructible edge case.

However, a limitation must not be classified as safe if it can cause destructive transformation.

### IMPORTANT

A test suite passing does not override a reproducible destructive counterexample.

Likewise, a theoretical extraction miss does not automatically justify rejecting an otherwise safe, scope-compliant patch.

## 9. Git and Collaboration Rules
GitHub Issues are the source of task ownership and scope.
- Work on the workflow-assigned branch (`claude/issue-*`).
- Pushing commits to the assigned `claude/*` feature branch and generating a PR link is explicitly authorized when an Issue requests a fix.
- Never modify or force-push `main`.
- Never merge PRs, approve reviews, or close Issues automatically.
- Do not overwrite another agent's work or silently rebase unrelated changes.
- Keep modifications strictly limited to the assigned task, and ensure no temporary files (such as `/tmp/sample`) are staged or committed.


## 10. Final Implementation Report

Every completed task must include:

### Summary
- Issue number.
- Fixed baseline SHA.
- Root cause.
- Implemented solution.

### Changes
- Modified files.
- Relevant functions and code regions.
- Explanation of why the change is minimal.

### Verification
- Targeted regression results.
- Historical regression results.
- Real sample results.
- Syntax validation.
- Runtime replay results.

### Remaining limitations
- Known limitations.
- Uncovered verification items.
- Any unresolved risks.

### Git status
- Working branch.
- Changed files.
- Commit SHA, if committed.
- PR status.

Use explicit labels:

- `PASS`
- `FAIL`
- `DEFERRED`
- `UNCOVERED`
- `KNOWN LIMITATION`

Never describe an incomplete verification as a successful result.

## 11. Final Engineering Principles

1. Preserve source code before maximizing extraction coverage.
2. Understand the actual root cause before editing.
3. Follow the assigned Issue, not an imagined broader objective.
4. Prefer minimal, testable changes.
5. Treat inferred identities as uncertain until proven.
6. When evidence is insufficient, preserve the original behavior.
7. Keep historical regressions visible.
8. Separate real defects from theoretical limitations.
9. Never fabricate test results.
10. Stop when the assigned acceptance criteria are satisfied.

## 12. Repository Map & Execution Environment (LFMC)
- Architecture: Pure browser-side JavaScript (no build step). Core extraction/transformation modules live in `src/`; third-party parser/archive libraries (`acorn`, `jszip`) live in `vendor/`.
- Historical context: Consult `docs/real-sample-regression.md` before modifying extraction rules to understand prior real-sample edge cases.
- Automated verification commands:
  - Unit & regression suite: `node test/run-tests.js`
  - Real sample suite: `node test/run-real-samples.js`
  - Syntax validation: Validate modified/generated JS with `node --check` or the repository's `vendor/acorn` parser.
- Cross-repository large sample packs:
  - When an Issue references a release tag or archive in the sample repository, download and extract it outside the repo workspace using `SAMPLE_REPO_TOKEN`:
    ```bash
    mkdir -p /tmp/sample
    GH_TOKEN=$SAMPLE_REPO_TOKEN gh release download <tag> -R zanesu154-rgb/BUG-Test-addon-world -D /tmp/sample
    unzip -q /tmp/sample/<archive> -d /tmp/sample/extracted
    ```
  - Never traverse or dump entire sample archives or large generated artifacts into stdout (to preserve context budget). Use `grep -rn` to locate specific failing snippets and `diff -u` to compare baseline vs. patched outputs.

**LFMC is a localization tool, not a JavaScript source-code rewriting engine with unrestricted authority.**

Its transformations must remain conservative, reproducible, and compatible with the original Minecraft add-on.
