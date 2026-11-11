# 0507 Remote links

Status: Ported (aws-jira `5909d04`, strand `9232fd6`), approved by the PO on 10 Nov 2026; awaiting verification
Parity rows: ISS-12

## Context and Jira reference

- **Jira DC** (an issue's **Link › Web Link**; [REST API for remote issue links](https://developer.atlassian.com/server/jira/platform/jira-rest-api-for-remote-issue-links/), checked 11 Nov 2026):
  - **A web link** is a URL and its link text, listed with the issue's links. Apps add **remote issue links** through REST: a `globalId` (the remote object's identity), an `application` (`type`, `name`), a `relationship` ("causes", "mentioned in"…), and the `object`: `url`, `title` (both required), `summary`, `icon` (`url16x16`, `title`), `status` (`resolved`, `icon`).
  - REST under `/rest/api/2/issue/{key}/remotelink`: list, find by `globalId`, create (a `globalId` already on the issue updates that link), update by id (every field replaced), delete by id or by `globalId`.
  - JQL: `issue in remoteLinksByGlobalId("…")`.
  - Adding or removing one is in the issue's history.
- **Strand today:** links between items only.

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20(summary%20~%20%22web%20link%22%20OR%20summary%20~%20%22remote%20link%22)%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Status | Strand |
|---|---|---|
| [JRASERVER-42710](https://jira.atlassian.com/browse/JRASERVER-42710) Edit a web link | Suggestion | **Built:** web links can be edited (R1) |
| [JRASERVER-30460](https://jira.atlassian.com/browse/JRASERVER-30460), [JRASERVER-34362](https://jira.atlassian.com/browse/JRASERVER-34362) Project import loses web links | Bugs | **Built:** project backups and the importer carry them (R5) |
| [JRASERVER-28064](https://jira.atlassian.com/browse/JRASERVER-28064) Query remote link data with JQL | Gathering interest | **Proposal P1** |
| [JRASERVER-62602](https://jira.atlassian.com/browse/JRASERVER-62602) A web link on the create screen | Gathering interest | **Proposal P2** |
| [JRASERVER-29072](https://jira.atlassian.com/browse/JRASERVER-29072) Web links as a search column | Gathering interest | **Proposal P3** |

**Proposals for the product owner** (not built until chosen):

- **P1: JQL on web links** (`webLink ~ "github.com"`).
- **P2: Web links in the create dialog.**
- **P3: A Web links column** in search results.

## Rules

- **R1: Web links.** On an item, people with Link issues add a web link (an `http` or `https` URL and its link text), change it and remove it. Links show with the item's links: the text (opening the URL in a new tab), the application and relationship when an app gave them, and a resolved mark from the remote status.
- **R2: Jira's REST** at `/rest/api/2/issue/{key}/remotelink`, in Jira's shapes: list, `?globalId=`, `/{id}`; POST creates, or updates the link with the same `globalId`; PUT replaces every field; DELETE by id or `?globalId=`. Strand's own API has the same at `/issues/{key}/remote-links`.
- **R3: Safety.** Only `http` and `https` URLs (icons too); opened with no access to Strand's page.
- **R4: Records.** Adding, changing and removing a web link go into the item's history and send Jira's `jira:issue_updated` with a `RemoteIssueLink` changelog item. JQL `issue in remoteLinksByGlobalId("…")`.
- **R5: Moves, backups and the item's REST** carry web links.

## Permissions

Browse projects to see them; Link issues (member) to add, change or remove them.

## Data model and migration

- `remote_links`: item, global id (unique per item), URL, title, summary, relationship, application, icon, status, who, when.
- `strand` gets the same migration in `supabase/migrations`.

## API

- `GET`, `POST /issues/:key/remote-links`, `PUT`, `DELETE /issues/:key/remote-links/:id`.
- Jira's `/rest/api/2/issue/{key}/remotelink` (R2).

## Screens

The item's links: **Web link** next to linking another item; the list with edit and remove.

## Scale

Indexed on the item; an item shows at most its latest 200.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R3, R4 | Server test: add, change, remove; javascript: refused; history; JQL by global id; non-members refused |
| R2 | Server test: Jira's REST round trip, upsert by globalId, delete by globalId |
| R5 | Server test: a moved item keeps its web links; the backup lists them |
| R1 | Browser journey: add a web link and open it |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Application links** (Confluence, Bitbucket through Jira's AppLinks) aren't configured in Strand; apps add remote links through the REST.

## Open questions

None.

## Changelog
