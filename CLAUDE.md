# JusttPrint

## Only push to ngolston/JusttPrint

All work goes to https://github.com/ngolston/JusttPrint (`origin`). Never push, open pull requests, create releases or issues, or call the API on any other GitHub repository, including the upstream project this was forked from. A local `.git/hooks/pre-push` hook also refuses pushes to the upstream repository.

## Before every merge into `main`

Every time, in this order:

1. Update `README.md` so it matches the changes (version line, features, setup, structure).
2. Bump the version (`npm version <x.y.z> --no-git-tag-version`; semver: breaking = major, features = minor, fixes = patch) and turn `## [Unreleased]` in `CHANGELOG.md` into `## [x.y.z] - <date>` with upgrade notes when needed.
3. Run `npm test`, `npm run test:e2e`, `npm run test:docker` (builds the image and smoke-tests it; needs Docker) and `npm run test:e2e:docker` (the end-to-end checks against the image; needs Docker; do not run it at the same time as `npm run test:e2e`, they share `tests/e2e/.work`).
4. Commit, merge into `main`, push `main`.
5. Tag `vx.y.z`, push the tag, and create the GitHub release on ngolston/JusttPrint with the changelog entry as notes.

## `todo:` shortcut

A message that starts with `todo:` is a request to add an item to [TODO.md](TODO.md), not to do the work.

1. Read TODO.md first.
2. If an existing item already covers it, update that item instead of adding a duplicate.
3. Otherwise add it where it fits:
   - Phase 1 (Docker container and web UI) or Phase 2 (desktop app). The container and web UI come first.
   - The matching section, positioned by importance (sections and items run from most to least important).
4. Write it in the file's style: `- [ ] **Short title.** One or two sentences on what and why`, with file links when known.
5. Several requests in one message (separate lines or `;`) become separate items.
6. Do not start the work. Reply in one or two lines: where the item went and why there. Ask only if the request is too vague to place.
7. Do not commit unless asked.
