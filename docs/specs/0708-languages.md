# 0708 Languages (decision)

Status: Decided (PO, 10 Nov 2026: "Only English fine"): option A, English only; nothing to build

## Context and Jira reference

- **Jira DC** (General configuration › Internationalisation, and Profile › Preferences › Language).
  - **Language packs** for about 20 languages ship with Jira. Each person picks a language in their profile; an admin sets the **default language** for everyone else.
  - Only Jira's own text is translated: menus, buttons, messages, system field names. Workflow, status, custom field, option and link-type names are whatever the admin typed. Statuses, issue types, priorities and resolutions can be given a translation per language.
  - JQL always uses the original names, not the translated ones.
- **Before this spec:** English only. Every text is written in the components and server messages; there is no translation layer.

## Community and Atlassian backlog

Checked 10 Nov 2026 on [jira.atlassian.com](https://jira.atlassian.com/issues/?jql=project%20%3D%20JRASERVER%20AND%20(summary%20~%20%22language%20pack%22%20OR%20summary%20~%20%22translation%22)%20ORDER%20BY%20votes%20DESC). The Atlassian Community's search couldn't be read by the tools that day.

| Atlassian issue | Votes | Status | Bearing on the decision |
|---|---|---|---|
| [JRASERVER-6798](https://jira.atlassian.com/browse/JRASERVER-6798) Translate what admins configure (workflows, fields, link types…) | 1101 | Future consideration since 2005 | The most wanted part is the admins' own names, which language packs don't touch |
| [JRASERVER-39215](https://jira.atlassian.com/browse/JRASERVER-39215) JQL can't use translated names | 98 | Gathering interest | Translated names and JQL disagree in Jira |
| [JRASERVER-40049](https://jira.atlassian.com/browse/JRASERVER-40049) Translate custom field options | | Suggestion | As JRASERVER-6798 |
| [JRASERVER-28496](https://jira.atlassian.com/browse/JRASERVER-28496) Pick the language from the browser | 44 | Gathering interest | Cheap to do if the app translates |
| Many bugs where one language pack breaks a page (JRASERVER-62916, JRASERVER-66732, JRASERVER-62405) | | Bugs | Every translated text is a text to test and keep up |

## The choice

- **A. English only (recommended for now).**
  - Record AD-05 as a deliberate divergence.
  - Dates, times and numbers already follow the browser's locale.
  - Nothing to build.
  - Migration from Jira loses nothing, because Jira's data is in the admins' own words.
- **B. Translate the app's own text.**
  - Every string moves into message files (the web app and the server's messages).
  - People choose a language in their profile; the admin sets the default; the browser's language decides when neither has (JRASERVER-28496).
  - This touches every screen, and every later spec must add its text in every language.
  - It needs a translator for each language the company wants.
- **C. B, plus the admins' names** (statuses, work types, priorities, resolutions, link types, field names and options) per language, which is what Jira users ask for most (JRASERVER-6798).
  - JQL would accept the original names and every translation (JRASERVER-39215).

**Recommendation:** A, until a team that works in another language is named.
- B, and C after it, can follow later without changing anything built now.

## Open questions

None. Answered 10 Nov 2026 by the PO: **A, English only**, as that is all the tool needs. B or C can follow later without changing anything built.

## Changelog

- 10 Nov 2026: the PO chose A, English only.
