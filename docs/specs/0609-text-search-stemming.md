# 0609 Text search as Jira's: words, stemming and Lucene syntax

Status: Ported (aws-jira `a8d8cc6`, strand `ddb021c`), pending work the PO asked to complete on 11 Nov 2026; awaiting verification
Parity rows: SR-03

## Context and Jira reference

- **Jira DC** ([search syntax for text fields](https://confluence.atlassian.com/jirasoftwareserver/search-syntax-for-text-fields-939938747.html)): `~` (contains) runs a Lucene query on a text field.
  - **Words, stemmed:** "customize" also finds customized, customizing, customer. Stop words (a, the, will, not…) are left out. Case doesn't matter. Several words with no operator are joined with AND, in any order.
  - **Indexing language:** stemming follows Administration › System › General configuration › **Indexing language**. **Other** turns stemming and stop words off. Changing it needs a re-index.
  - **Phrases:** `text ~ "\"full screen\""`.
  - **Wildcards:**
    - `?` is exactly one character, `*` is zero or more.
    - They work in the middle of a word (`wi*95`), and since 8.6 at the start (`*box`).
    - Wildcards match the index's stems, so `customiz*` misses "customize".
  - **Operators:**
    - `AND` (`&&`), `OR` (`||`), `NOT` (`!`), `+` and `-`, with parentheses for grouping.
    - Operators are written in capitals.
    - A query with only exclusions finds nothing.
  - **Fuzzy and proximity:** `roam~` finds foam and roams. `"atlassian jira"~10` finds the two words within ten words of each other. Boosting (`^4`) changes relevance.
  - **Special characters** aren't indexed, so they're ignored.
  - **Fields:**
    - `summary`, `description`, `environment` and `comment`, plus any free-text custom field.
    - `text` covers all of them: summary, description, environment, comments and every free-text custom field.
    - Quick search uses the same engine.
- **Strand today:**
  - `summary`, `description` and text custom fields match a substring (`ilike`).
  - `text` matches whole words without stemming (`simple`), or a substring of the title.
  - There's no `comment` field, and comments aren't searched at all.
  - Wildcards, operators and phrases are taken literally.

## Community and Atlassian backlog

| Ticket | Kind | What people ask | Here |
|---|---|---|---|
| [JRASERVER-6218](https://jira.atlassian.com/browse/JRASERVER-6218) | Suggestion (closed in 8.6 with prefix and suffix wildcards) | Search for part of a word | R2: wildcards match the words as written, so `*cula*` finds "calculate" |
| [JRASERVER-1922](https://jira.atlassian.com/browse/JRASERVER-1922), [JRASERVER-22406](https://jira.atlassian.com/browse/JRASERVER-22406), [JRASERVER-26443](https://jira.atlassian.com/browse/JRASERVER-26443) | Duplicates | "fatal" doesn't find "fatalerror"; leading wildcards | R2 |
| [JRASERVER-33306](https://jira.atlassian.com/browse/JRASERVER-33306) | Bug, won't fix | Hyphenated words | Punctuation splits words, as in Jira |
| [JRASERVER-67115](https://jira.atlassian.com/browse/JRASERVER-67115) | Bug | Text with several underscores or periods finds nothing | Same: punctuation splits words |
| [JRASERVER-36689](https://jira.atlassian.com/browse/JRASERVER-36689) | Suggestion | Quick search should be fuzzy | P1 |

## Rules

- **R1: Words, stemmed.**
  - `~` matches words in the workspace's **indexing language** (System settings › Search). Jira's default is English.
  - The setting lists Postgres's languages, plus **Other**, which turns stemming and stop words off.
  - Several words with no operator must all appear, in any order. Case doesn't matter, and punctuation separates words.
  - A query of only stop words finds nothing, as in Jira.
- **R2: Jira's syntax.**
  - Phrases in escaped quotes.
  - `*` and `?` anywhere in a word, including at the start. They match the words as written, not their stems, so `customiz*` finds "customize" and `*cula*` finds "calculate". This is Jira's syntax with fewer misses.
  - `AND`, `&&`, `OR`, `||`, `NOT`, `!`, `+` and `-`, with parentheses. A query with only exclusions finds nothing.
  - Fuzzy `word~` matches words at most two edits away (Lucene's default).
  - Boosts (`^N`) are accepted and ignored, because Strand orders by the JQL's ORDER BY, not by relevance.
  - Unbalanced quotes or parentheses are a JQL error that says where the problem is.
- **R3: Fields.**
  - `summary`, `description`, any text custom field (single or multi-line), and a new **`comment`** field.
  - `comment` searches only the comments the person can read (comment visibility, spec 0203).
  - `text` searches all of them.
  - `labels ~` keeps its substring match (a Strand extra; Jira has no `~` on labels).
  - `!~` is the opposite of `~`.
- **R4: Quick search.** The search box matches keys as before, and otherwise uses the same rules as `text ~`.
- **R5: Changing the language** re-indexes every item and comment in the background, as a job. Until it finishes, some items may be found only by their old word forms, as in Jira before a re-index.

## Permissions

- Search: as before.
- Comments the person can't read never make an item match.
- The indexing language is a System setting: system administrators only.

## Data model and migration

- `issues.search_text` holds an item's searchable text: summary, description and text custom fields. `issues.search` stops being generated in the simple language and becomes its word index in the workspace's language. A trigger keeps both up to date on every write.
- `comments.search` is the comment body's word index.
- Word indexes (GIN) answer words and phrases. Trigram indexes on `search_text` and comment bodies answer wildcards. `summary ~` and `description ~` use the item's indexes, then check their own text.
- The language is read through `search_config(workspace)`, so the database and the server agree on it.
- The `fuzzystrmatch` extension measures edit distance for fuzzy words. Fuzzy words are matched against the index's word roots, so `roam~` also finds "roaming".
- Existing rows are filled in by the migration.

## API

- JQL as above. `GET /jql/check` reports text-query errors.
- New setting `search` `{ indexingLanguage }` (public: no).

## Screens

- System settings › Search: **Indexing language**. A note says items re-index in the background.
- JQL autocomplete gains `comment`.

## Scale

- Words, phrases and trailing `*` use the GIN indexes.
- Fuzzy matching and `*` or `?` elsewhere in a word check the words of each candidate item. The other conditions in the query narrow the candidates first.
- The re-index job runs in batches of 1,000.

## Acceptance

| Rule | Proved by |
|---|---|
| R1–R3 | Unit test: the text-query parser (words, phrases, wildcards, operators, fuzzy, errors) |
| R1–R5 | Server test: stemming and stop words; Other; phrases; wildcards (leading, middle, trailing); AND, OR, NOT, `-` and only-exclusions; fuzzy; `summary`, `description`, `comment` (a restricted comment doesn't match for others), `text`, a custom field; quick search; changing the language re-indexes |
| R3 | Browser journey: a JQL search with `text ~ "customize"` finds "Customized login" |

## Strand branch

Same rules. Items behind a security level stay out as before. Comments follow their visibility.

## Out of scope and deliberate divergences

- **Proximity** (`"a b"~N`): Strand finds the words anywhere in the field, not within N words of each other.
- **Relevance:** Jira can sort by relevance in quick search. Strand keeps its usual orders.
- **Environment:** Strand has no Environment field. An imported Environment becomes a text custom field, which `text ~` searches.

## Proposals (not built until chosen)

- **P1: Fuzzy quick search.** When the search box finds nothing, try the words fuzzily and say so ("Showing close matches"), as JRASERVER-36689 asks.

## Open questions

None.

## Changelog
