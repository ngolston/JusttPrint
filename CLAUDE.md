# Printventory

## Never send anything to TechJeeper/Printventory

Never push, open pull requests, create releases or issues, call the API, or run scripts that target https://github.com/TechJeeper/Printventory. Work goes to the fork, https://github.com/ngolston/Printventory (`origin`). `scripts/upload-to-github.ps1` and `scripts/push-printventory-github.ps1` push there, so do not run them. A local `.git/hooks/pre-push` hook also refuses those URLs.

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
