# Changelog workflow

`CHANGELOG.md` is the repository's source of truth for user-facing changes.

## Required behavior for coding agents

For every pull request that changes something a user can see or experience:

1. Review the final diff and identify the actual user-visible results.
2. Update `CHANGELOG.md` in the same pull request.
3. Add concise bullets under `## Unreleased` using the most appropriate heading:
   - `Added` — a new capability.
   - `Improved` — an existing capability works or feels better.
   - `Fixed` — incorrect or broken behavior was corrected.
   - `Security` — a user-relevant security improvement.
   - `Removed` — a user-facing capability was removed.
4. Write one bullet for each distinct user-visible result.
5. If the pull request has no user-facing change, do not add a changelog entry and state `No user-facing change` in the pull request description.

## Writing rules

Write from the user's perspective.

Good:

```markdown
- Account reordering now shows a stable drop position while dragging.
- Long account lists can now be scrolled without moving the navigation or update button.
```

Avoid implementation details:

```markdown
- Refactored pointer event handling in `AccountRow.tsx`.
- Added `overflow-y: auto` to the sidebar list.
```

Also avoid:

- test-only, dependency, formatting, or internal refactor notes;
- claims that are not supported by the final code;
- duplicate bullets describing the same result;
- PR titles, commit hashes, or file names in user-facing entries.

## `Unreleased` format

Keep unreleased changes at the top of `CHANGELOG.md`:

```markdown
## Unreleased

### Added

- Example new feature.

### Improved

- Example improvement.

### Fixed

- Example bug fix.
```

Omit empty headings. Remove the `_No unreleased user-facing changes yet._` placeholder when adding the first entry.

## Release handling

Normal coding tasks must only update `## Unreleased`.

A release task may:

1. Rename the completed `## Unreleased` section to `## <version> - <YYYY-MM-DD>`.
2. Insert a new empty `## Unreleased` section above it.
3. Reuse the completed section as the GitHub Release description.

Released entries should remain unchanged except for correcting a clear typo or factual error.

## Pull request self-check

Before opening or finishing a pull request, confirm one of these is true:

- `CHANGELOG.md` includes every user-visible result from the pull request.
- The pull request explicitly states `No user-facing change`.
