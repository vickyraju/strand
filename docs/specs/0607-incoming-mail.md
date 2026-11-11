# 0607 Incoming mail

Status: Ported (aws-jira `aa98503`, strand `87e5694`), approved by the PO on 10 Nov 2026; awaiting verification
Parity rows: NT-04

## Context and Jira reference

- **Jira DC** (Administration › System › **Incoming mail**; [Creating issues and comments from email](https://confluence.atlassian.com/adminjiraserver/creating-issues-and-comments-from-email-938847641.html), checked 11 Nov 2026):
  - **Mail servers:** POP, IMAP, Microsoft Graph, or **Local files** (an outside service drops one message per file under Jira's home). IMAP and Graph mail is marked read once processed; POP and file messages are removed; messages that fail stay.
  - **Handlers**, each reading one server every *Delay* minutes:
    1. Create a new issue or add a comment to an existing issue;
    2. Add a comment from the non quoted email body;
    3. Add a comment with the entire email body;
    4. Create a new issue from each email message;
    5. Add a comment before a specified marker or separator (a split regex; Atlassian recommends this one).
  - **Parameters** (each handler takes some): Project, Issue Type, Strip Quotes, Catch Email Address, Bulk (ignore, forward, delete, accept), Forward Email, Create Users, Default Reporter, Notify Users, CC Assignee, CC Watchers, Split Regex.
  - **The sender** is the Jira user with the From address; otherwise the Default Reporter, with the sender's address added to the description; Create Users makes an account instead.
  - **Which issue:** the first issue key in the subject; else the email the message replies to (In-Reply-To), if that one created an issue; else a new issue. The subject becomes the summary (required), the body the description; a high-priority email makes a higher-priority issue. Attachments come too.
- **Strand today:** none.

## Community and Atlassian backlog

Checked 11 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20(summary%20~%20%22mail%20handler%22%20OR%20summary%20~%20%22incoming%20mail%22)%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Type | Strand |
|---|---|---|
| [JRASERVER-71656](https://jira.atlassian.com/browse/JRASERVER-71656) Microsoft Graph for incoming mail | Suggestion (now in DC) | **Built** (R1) |
| [JRASERVER-40671](https://jira.atlassian.com/browse/JRASERVER-40671) Turn a handler off | Suggestion | **Built** (R2) |
| [JRASERVER-33116](https://jira.atlassian.com/browse/JRASERVER-33116) Mail matched to deactivated people | Bug | **Built:** only active people (R3) |
| [JRASERVER-67511](https://jira.atlassian.com/browse/JRASERVER-67511) Mail ignores the default priority | Bug | **Built:** the list's default unless the email is high priority (R4) |
| [JRASERVER-33345](https://jira.atlassian.com/browse/JRASERVER-33345) Rejected messages are hard to see | Bug | **Built:** each run lists every message and what happened (R7) |
| [JRASERVER-67539](https://jira.atlassian.com/browse/JRASERVER-67539) Mail health monitoring | Suggestion | **Built** in part: a handler's last run and its errors (R7) |
| [JRASERVER-70637](https://jira.atlassian.com/browse/JRASERVER-70637) Incoming mail blocks other scheduled work | Bug | **Built:** each run is a queued job, one per handler at a time (R7) |
| [JRASERVER-30804](https://jira.atlassian.com/browse/JRASERVER-30804) Split regex and `^`, `$` | Bug | **Built:** the regex's own flags (`/^--$/m`) are honoured (R4) |
| [JRASERVER-15129](https://jira.atlassian.com/browse/JRASERVER-15129), [JRASERVER-14543](https://jira.atlassian.com/browse/JRASERVER-14543) Strip signatures; Outlook replies | Suggestions | **Proposal P1** |
| [JRASERVER-36039](https://jira.atlassian.com/browse/JRASERVER-36039) No attachments from a handler | Suggestion | **Proposal P2** |
| [JRASERVER-67489](https://jira.atlassian.com/browse/JRASERVER-67489) No comments on other projects' items | Suggestion | **Proposal P3** |

**Proposals for the product owner** (not built until chosen):

- **P1: Outlook-aware replies:** cut a reply at Outlook's "From: … Sent: …" header and at common signature markers, without a regex.
- **P2: A handler without attachments.**
- **P3: Comments only on the handler's project.**

## Rules

- **R1: Mail servers.** Administration › Incoming mail: add, change and remove (not while a handler reads it) an **IMAP** server (host, port 993, TLS, username, password, folder), a **Microsoft 365** mailbox through Graph (tenant, application id, client secret, mailbox, folder), or **message files** (a folder inside the server's mail folder, `STRAND_MAIL_DIR`). Passwords and client secrets are write-only and sealed; changing where a server connects needs the secret again. **Test** connects, signs in and counts unread mail.
- **R2: Handlers.** Jira's five, each with the parameters Jira gives it (Project, Work type, Strip quotes, Catch email address, Bulk, Forward email, Default reporter, CC assignee, CC watchers, Split regex), a server, how often (minutes), and on or off. **Run now** reads at once.
- **R3: The sender** is the active person of the workspace with the From address (or that username); otherwise the Default reporter, with "(Sent by …)" added; otherwise the email isn't handled. What the person can't do (create in the project, comment on the item) isn't done.
- **R4: What it makes.** A comment goes to the first work item key in the subject (earlier keys of moved or re-keyed items too), else to the item the replied-to email created; the create handlers otherwise make a work item: the subject as summary (required), the text as description, the handler's project and work type, High when the email is high priority (else the list's default), CC assignee: the first person in To or Cc who can be assigned; CC watchers: those in To and Cc who can see it. Strip quotes and the non-quoted handler leave out lines starting `>` or `|`; the marker handler keeps what comes before its split regex (the whole text if it doesn't match or is broken).
- **R5: Automatic and stray mail.** Mail marked bulk (Precedence bulk, junk or list; Auto-Submitted other than no) is ignored, deleted, forwarded or accepted as the handler says; with a Catch email address, other mail is ignored; what can't be handled goes to the Forward email address when there is one.
- **R6: Attachments** come with the email when attachments are on, each within the size limit; pictures inside the email's own text don't.
- **R7: Runs.** Each run is a queued job, one per handler at a time; IMAP and Graph mail is marked read and message files removed once handled; mail that fails stays for the next run, as Jira's. The handler shows its last run: how many were created, commented, ignored, forwarded or failed, and each message with why.
- **R8: Records.** Servers and handlers are audited (secrets only as "set" or "changed"); items and comments are by their sender, and say "Created this work item from an email".

## Permissions

System administrators who signed in themselves.

## Data model and migration

- `mail_servers`: name, kind, settings, sealed secret.
- `mail_handlers`: server, name, kind, on, minutes, parameters, last run and result.
- `mail_message_ids`: an email's Message-ID and the item it created.
- `strand` gets the same migration in `supabase/migrations`.
- New server libraries: `imapflow` (IMAP) and `mailparser` (reading email), both MIT.

## API

- `GET`, `POST /admin/mail-servers`; `PUT`, `DELETE /admin/mail-servers/:id`; `POST /admin/mail-servers/test`.
- `GET`, `POST /admin/mail-handlers`; `PUT`, `DELETE /admin/mail-handlers/:id`; `POST /admin/mail-handlers/:id/run`.

## Screens

Administration › Incoming mail: mail servers (add, edit, Test), mail handlers (add, edit, Run now, last run and its messages).

## Scale

At most 50 messages a run per handler; a handler runs at most once at a time across servers.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R2, R3, R4, R5, R7, R8 | Server test (message files): create and comment; key in the subject and replies; default reporter; CC watchers; priority; bulk ignored; unknown sender fails and stays; the marker handler; refused parameters; secrets required; the folder kept inside the mail folder; audited; non-admins refused |
| R4 | Unit test: what each handler keeps of the text |
| R6 | Not yet proved by a test: the suites run without file storage |
| R1, R2 | Browser journey: an admin adds a message-file server and a handler; an email becomes a work item |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **POP:** IMAP and Microsoft 365 cover the mail services in use; POP mailboxes are usually also IMAP.
- **Create Users and Notify Users:** people come from the directories and sign-in (specs 0711, 0712); email doesn't make accounts.

## Open questions

None.

## Changelog
