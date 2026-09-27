# Scriptorium project rules

## Project purpose
Scriptorium is a Bible reading and comparison app.

## Current goals
- Migrate app data/storage to Supabase
- Add user login and per-user sync
- Support user-uploaded Bible versions in a copyright-conscious way
- Do not store a whole Bible version as a single blob
- Improve mobile layout and reading experience
- Add reading mode, recent passages, and bookmarks

## Technical preferences
- Inspect the existing architecture before making major changes
- Prefer small, reversible edits
- Keep schema normalized and queryable
- Avoid destructive rewrites unless clearly justified
- Explain the plan before large refactors
- Preserve existing working behavior where possible

## UX preferences
- Mobile-first layout
- Make reading pane wider and less cramped
- Use screen space efficiently
- Keep controls accessible but not dominant

## Workflow
- Before editing, identify where Bible data is loaded, stored, and rendered
- After changes, summarize exactly what changed
- Flag risks, assumptions, and unfinished work clearly