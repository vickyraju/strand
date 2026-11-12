# 0031 GitHub development integration

Status: Implemented

## Context and Jira reference

GitHub sends the app its pull requests, branches and commits through a signed webhook. The app links each one to the items its text names by key, so an item shows the work done for it. This spec is the receiver and the linking. Extended by spec 0707 (connecting accounts in Administration, installations that wait for an admin, repositories limited to some projects, the Development panel, its API and JQL) and spec 0718 (workflow triggers).

- **Jira DC:** the DVCS connector (Administration › Applications › DVCS accounts) reads GitHub accounts. It links a commit, branch or pull request to an issue when its key appears in the commit message, the branch name or the pull request title. Smart commits (`#comment`, `#time`, `#transition`) act on the issue. See also [development fields in JQL](https://confluence.atlassian.com/jirasoftwareserver/advanced-searching-development-fields-reference-973491363.html).
  - The app links the same way, and also reads keys in lowercase and in the pull request's description.
  - In place of smart commits, it records closing words ("Fixes PAY-12") and `skip PAY-12` (R8, R9). Neither changes the item.

## Rules

- **R1: A signed receiver.** GitHub posts to `/integrations/github/webhook`, with no sign-in.
  - Every call must carry `X-Hub-Signature-256`: `sha256=` and the HMAC-SHA256 of the raw body, keyed by the server's `GITHUB_WEBHOOK_SECRET`. The check takes constant time, and GitHub's published test vector verifies.
  - A missing, `sha1=` or wrong signature, or a changed body, is refused: 401 "Invalid signature".
  - With no secret set, the receiver is closed: 503 "GitHub webhook is not configured".
- **R2: Each delivery once, the newest news wins.**
  - A delivery id (`X-GitHub-Delivery`) that was processed before answers `{ ok: true, duplicate: true }` and changes nothing.
  - Each pull request, branch and commit is one record per repository. A redelivery under a new id updates that record and makes no second one.
  - A delivery older than the record (by GitHub's update time) is ignored, so a late delivery can't undo a newer one.
- **R3: Pull requests.** A `pull_request` event is one record with:
  - its number, address and title;
  - its state: `open`, `merged`, or `closed` when closed without merging;
  - its from and to branches;
  - its author's login;
  - whether it is a draft.

  Its keys are read from the branch name, the title and the body, in that order.
- **R4: Reviews.** A submitted `pull_request_review` sets the review state:
  - `approved` or `changes_requested` set it, in any casing;
  - a plain comment leaves it as it was;
  - a dismissed review clears it.

  Other review actions (edited) record nothing. A merge keeps the review state.
- **R5: Pushes.** A push to a branch (`refs/heads/…`) records the branch and its commits:
  - at most 50 commits per push;
  - each commit's title is the first line of its message (up to 300 characters), and its message is kept up to 4,000 characters;
  - the author's login and name are kept, never an email address.

  A push of a tag records nothing. A push that deletes the branch marks it deleted.
- **R6: Branches and other events.**
  - A `create` or `delete` event for a branch records it as active or deleted. One for a tag records nothing.
  - A deleted branch is hidden from the item.
  - Unknown events (`ping`) and malformed payloads record nothing and answer 200.
- **R7: Keys.** Only the workspace's real project keys match, so `UTF-8`, `SHA-256` or `ZZZ-4` never do.
  - A key matches in any case, as a whole token: `XPAY-1` doesn't match, and `PAY-120` isn't `PAY-12`.
  - Keys are reported in upper case.
  - A key links only to an item that exists and isn't deleted.
- **R8: Closing words.** A key after a closing word marks its link as **closing**. The closing words are close, closes, closed, closing, fix, fixes, fixed, fixing, resolve, resolves, resolved, resolving, complete, completes, completed and completing. A colon after the word is allowed.
  - A list shares the word: "Fixes PAY-1, PAY-2 and API-3" closes all three. Commas, "and" and "&" join a list.
  - Other words ("relates to", "Refs:") don't close.
  - Branch names are never read for closing words.
- **R9: One link per key.** A key named in several places of one record is one link.
  - The link's source is the first place that named the key, in the order of R3.
  - The link is closing when any source closes it.
  - `skip KEY` or `ignore KEY`, anywhere in the record, removes that key from every source.
- **R10: Edits replace links.** A pull request's or branch's links are its text as it is now. A key that its title, body or branch no longer names is unlinked. A commit's links are only ever added.
- **R11: Uninstalling.** When GitHub reports the app's installation as deleted, the account and everything it sent are removed: repositories, records and their links.
- **R12: A branch name for an item.** The suggested name is the key in lowercase, then the title:
  - accents are removed;
  - every run of other characters becomes "-";
  - the name is at most 60 characters, and never ends with "-".

  For example, `PAY-12` "Fix login redirect!" gives `pay-12-fix-login-redirect`, and `PAY-1` "???" gives `pay-1`. The Development panel offers it (spec 0707 R4).

## Permissions

- **The receiver:** no user. Trust comes only from the signature (R1).
- **Reading what is linked to an item, and administering accounts:** spec 0707.

## Data model

`20261014210000_github_integration.sql`:
- `integrations`: the provider, the installation id, the account login and the status. Spec 0707 adds `pending`.
- `repositories`: the external id, the full name, the default branch, and `project_ids` (spec 0707).
- `dev_entities`: the kind (`commit`, `branch`, `pull_request`; `build` and `deployment` are allowed but nothing writes them), the external id, the address, the title, the state, the author (no email), the branches, the review state, the payload and `source_updated_at`. Unique by repository, kind and external id.
- `dev_links`: the item, the record, `via` (`branch`, `title`, `body`, `commit`) and `closing`.
- `webhook_deliveries`: the delivery id, the event, the status (`received`, `processed`, `failed`) and the error.

## API

- `POST /integrations/github/webhook`, with the headers `X-GitHub-Event`, `X-GitHub-Delivery` and `X-Hub-Signature-256`. The answer is `{ ok, duplicate?, ignored?, records? }`.
  - 401: a bad signature.
  - 503: no secret set.
  - 400: a body that isn't JSON.
  - 500: a failure. The delivery is marked failed, its error is kept, and a redelivery of the same id is tried again.
- `installation` events: `deleted` removes the account. `suspend` and `unsuspend` pause it and start it again. `installation_repositories` adds and removes repositories.
- The item's answer, `GET /issues/:key/development`: spec 0707 R6.

## Screens

None of its own. What it records shows in the item's Development panel (spec 0707).

## Scale

- A push keeps at most 50 commits.
- Linking reads the workspace's project keys and the named items in one query per record.

## Acceptance

| Rule | Test |
|---|---|
| R1 | Unit test (`github.test.ts`): GitHub's test vector; tampering, a wrong secret, a missing header, `sha1=` and no secret fail. Server tests: a wrong or missing signature is 401; no secret is 503 |
| R2 | Server test: the same delivery again is a duplicate with one record; an older delivery arriving late is ignored |
| R3 | Unit test: a pull request's state, branches, author and the three texts. Server test: an opened pull request links to the key it names, merged later |
| R4 | Unit test: approved and changes requested in any casing, comments, dismissal, edits. Server test: approved survives the merge |
| R5 | Unit test: the branch, 50 commits, no emails, tags ignored, a deleted branch. Server test: a push links its branch and commit, and stores no email |
| R6 | Unit test: create and delete events, tags, unknown events, malformed payloads. Server test: a deleted branch is hidden |
| R7 | Unit test (`links.test.ts`): real keys only, whole tokens, any case. Server test: a key links only that item |
| R8 | Unit test: closing words, lists, other words; branch names never close. Server test: "Fixes GH-2" closes, in a title and in a commit |
| R9 | Unit test: one link per key, first source wins, closing from any source; skip and ignore |
| R10 | Server test: an edited title moves the link, and a branch and title that no longer name a key unlink it |
| R11 | Server test: uninstalling removes every record and link |
| R12 | Unit test: `branchName` makes a short, git-safe name |

## Out of scope and deliberate divergences

- **Smart commits** (`#comment`, `#time`, `#transition`): not read. Closing words are recorded, and workflow triggers (spec 0718) move items.
- **GitLab and Bitbucket, builds and deployments:** spec 0707.
- **Mapping GitHub logins to people:** `user_identities` exists but nothing fills it.
