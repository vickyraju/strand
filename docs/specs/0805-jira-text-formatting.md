# 0805 Jira's text formatting, imported

Status: Approved (pending work, 12 Nov 2026)
Parity rows: (importer, spec 0802)

## Context and Jira reference

- **Jira DC** stores descriptions, comments and multi-line text fields in its **wiki markup** ([text formatting notation](https://jira.atlassian.com/secure/WikiRendererHelpAction.jspa?section=all)), and REST v2 returns it as written:
  - **headings and text:** `h1.` to `h6.`; `*bold*`, `_italic_`, `-strike-`, `+underline+`, `{{monospace}}`, `^sup^`, `~sub~`, `??citation??`;
  - **lists:** `*` and `#` lists, nested by repetition (`**`, `#*`);
  - **tables:** `||heading||` and `|cell|`;
  - **links:** `[text|url]`, `[url]`, `[~username]` mentions, `[KEY-1]`, `[^attachment.pdf]`;
  - **images:** `!image.png!`, with options such as `|thumbnail`;
  - **blocks:** `{code:java}…{code}`, `{noformat}…{noformat}`, `{quote}…{quote}`, `bq.`, `{panel}…{panel}`, `{color:red}…{color}`;
  - **other:** `----`, `\\` for a line break, and emoticons such as `(/)`, `(x)`, `(!)`, `:)`.
- **Strand today:**
  - The importer (spec 0802) stores that text unchanged, so imported work shows raw markup.
  - Strand writes a safe subset of Markdown: headings 1–3, bold, italic, code, links, lists, quotes, task lists and `@Name` mentions. It has no tables, images, strikethrough or rules.

## Rules

- **R1: Converted on import.** Descriptions, comments and multi-line text fields arrive as Strand's Markdown:
  - **Text:**
    - `h1.` becomes `#`, `h2.` becomes `##`, and `h3.` to `h6.` become `###`;
    - bold, italic, strike and monospace become their Markdown;
    - underline, superscript, subscript and colour keep their text without the styling;
    - a citation becomes italic text after a dash.
  - **Lists:** nested by indentation.
  - **Tables:** Markdown tables.
  - **Blocks:** code and noformat become fenced code, with the language kept. Quotes, `bq.` and panels become quotes, keeping a panel's title as its first line.
  - **Links and mentions:**
    - `[text|url]` becomes a link, and a bare `[url]` its address;
    - `[~username]` becomes `@` and the person's name, as imported;
    - `[KEY-1]` keeps the key.
  - **Attachments:** `[^file]` becomes a link to the item's attachment, and `!image.png!` shows the attachment's picture.
  - **Other:** `----` becomes a rule, `\\` a line break, and common emoticons their symbols.
  - Text inside code, noformat and monospace is left as written.
- **R2: Strand shows it.** The Markdown view gains:
  - tables;
  - `~~strike~~`;
  - a horizontal rule;
  - pictures of the item's own attachments, `![name](attachment:name)`, loaded through the same short-lived links as the Attachments section. An attachment that isn't there shows its name.
- **R3: Nothing is lost.** Markup Strand doesn't recognise, such as unknown `{macros}`, stays as text. A malformed table becomes plain lines.

## Permissions

As for the importer (system administrators). Attachment pictures load only for people who can see the item, as attachments do.

## Data model and migration

None.

## API

None. The import converts as it writes.

## Screens

Any Markdown view: an item's description and comments.

## Scale

The conversion is pure text work, a few milliseconds per item.

## Acceptance

| Rule | Proved by |
|---|---|
| R1, R3 | Unit test: each construct converts, nested lists, tables, code left alone, unknown macros kept |
| R1 | Server test: an imported item's description and comment arrive as Markdown, a mention named after the person, an image pointing at its attachment |
| R2 | Browser journey: an item whose description has a table, strike and a rule shows them; a picture whose attachment isn't there shows its name (the browser journeys run without file storage) |

## Strand branch

Same rules.

## Out of scope and deliberate divergences

- **Colour, underline, superscript and subscript:** Strand's Markdown has no styling for them, so their text stays without it.
- **Already imported items** keep their text. Re-import to convert them.
- **Jira's macros from apps** (Confluence and other app macros) stay as text.

## Proposals (not built until chosen)

None.

## Open questions

None.

## Changelog
