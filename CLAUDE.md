# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workflow Rules (execute in order)

### 1. PRE-TASK: Consult Memory (BLOCKING)

Before writing ANY code or making ANY changes:

- Read MEMORY.md for relevant context
- Search claude-mem (`mem-search` skill or MCP tools) for past decisions, bugs, and patterns related to the task
- DO NOT proceed until this step is done

### 2. Unit Tests (BLOCKING)

- All new/changed code MUST be covered by unit tests before the task is considered complete
- If no test framework exists yet, set one up before proceeding

### 3. Test Suite (BLOCKING)

- ALL existing project unit tests MUST pass before the task is complete
- If a test fails, fix it — do not skip or disable it

### 4. Memory Update (BLOCKING — NEVER SKIP)

At the END of every task, ALWAYS update BOTH:

- `MEMORY.md` (local auto-memory)
- `claude-mem` (cross-session memory via MCP tools)

This MUST happen BEFORE asking about commit/push/deploy.
This is the most frequently skipped rule — pay extra attention.

### 4b. Aggiornamento del Product Design (BLOCKING)

At the END of every task, review and update **if anything changed**:

- `docs/product-design.md` — the canonical product design (architecture, data model, feature map, invariants, roadmap).
- `docs/manuale-operativo.md` — the operational manual (user procedures + dev/maintenance guide).

If the task added/changed/removed a feature, schema, route, invariant, or workflow, reflect it in these docs and bump the "Ultimo allineamento" date. If nothing relevant changed, no edit is needed. This keeps the product design a faithful, always-current description of the app.

### 4c. Subagent orchestration safety (BLOCKING)

We work directly on `main` (see §5). Committing and pushing are **controller-only** actions. When dispatching subagents (implementers, reviewers, fixers):

- **Subagents MUST NEVER `git checkout`, `commit`, or `push`.** They MUST NOT create branches or `git push` to any remote, ever. They edit only the working tree on `main`; the controller stages and commits.
- **Subagents touch only the files named in their task.** Anything outside that scope — even an obviously good "while I'm here" fix — must be reported back, not committed. If a subagent is tempted to do more, it returns its findings to the controller instead.
- State these constraints **explicitly in every dispatch prompt** ("stay on `main`; edit only the named files; never checkout/branch/commit/push; never push to a remote; if tempted to do more, stop and report").
- **The controller verifies each subagent's report against reality** (`git log`, `git status`, the diff) before trusting it — a subagent's self-reported status can omit out-of-scope or destructive actions. If the diff shows unexpected commits/branches/files, investigate before proceeding.

> This rule exists because a subagent once pushed an out-of-scope commit to `origin/main` and hid it from its report.

### 5. End of Task

- Ensure ESLint passes in any project where code has been modified
- Verify that every project affected by your changes builds successfully
- **Work directly on `main` — do NOT create feature branches.** All task work happens on `main`. Do not branch, do not squash-merge.
- **Auto-commit to `main` (standing authorization — do NOT ask first):** once the task is complete and `npm run lint` / `npm test` / `npm run build` pass and memory is updated, commit on `main` and **push** to `origin`. Concretely:
  1. `git add <changed files>` — stage only the files your task touched
  2. `git commit -m "<good message>"` — never include a co-author; write a clear conventional-commit summary of the whole task
  3. `git push origin main`
- This applies to every routine task. Skip the auto-commit and ask first only if: tests/lint/build fail, there are unresolved review concerns, or the change is risky/irreversible (migrations on prod data, secrets, deploy steps). If the user explicitly said to hold, do not commit.
- Always ask if the next task should be done in a new session

## Behavioral Guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

Tradeoff: These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

Don't assume. Don't hide confusion. Surface tradeoffs.

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

Minimum code that solves the problem. Nothing speculative.

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

Touch only what you must. Clean up only your own mess.

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

Define success criteria. Loop until verified.

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```text
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

These guidelines are working if: fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
