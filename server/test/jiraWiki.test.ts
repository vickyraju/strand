import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wikiToMarkdown as md } from '../src/shared/jiraWiki.ts'

test('[0805.R1][0805.R3] Jira wiki markup becomes Strand’s Markdown', () => {
  const person = (u: string) => ({ ann: 'Ann Lee' } as Record<string, string>)[u]
  // headings and text
  assert.equal(md('h1. Title\nh2. Sub\nh5. Deep'), '# Title\n## Sub\n### Deep')
  assert.equal(md('*bold* and _italic_ and -gone- and +under+ and ^sup^ ~sub~ ??Jira??'), '**bold** and *italic* and ~~gone~~ and under and sup sub *— Jira*')
  assert.equal(md('a well-known re-run and 5-3 = 2'), 'a well-known re-run and 5-3 = 2')                   // hyphens in words stay
  assert.equal(md('{{x_y_z *not bold*}} and *bold*'), '`x_y_z *not bold*` and **bold**')
  assert.equal(md('{color:red}Red{color} text'), 'Red text')
  // lists, nested
  assert.equal(md('* one\n** one.a\n# first\n#* mixed\n- dash'), '- one\n  - one.a\n1. first\n  - mixed\n- dash')
  // links, mentions, keys, attachments, images
  assert.equal(md('See [the docs|https://x.test/a_b] and [https://y.test] by [~ann] or [~bob] on [PAY-12] [^log.txt]', { person }),
    'See [the docs](https://x.test/a_b) and https://y.test by @Ann Lee or @bob on PAY-12 [log.txt](attachment:log.txt)')
  assert.equal(md('!screen shot.png|thumbnail! and !https://img.test/a.png!'), '![screen shot.png](attachment:screen%20shot.png) and [https://img.test/a.png](https://img.test/a.png)')
  assert.equal(md('Wow! Great!'), 'Wow! Great!')                                                       // not an image
  // blocks: code left as written, noformat, quote, bq, panel
  assert.equal(md('{code:java}\nint *x* = a_b;\n{code}'), '```java\nint *x* = a_b;\n```')
  assert.equal(md('{noformat}*raw*{noformat}'), '```\n*raw*\n```')
  assert.equal(md('{quote}\nSaid *this*\n{quote}\nafter'), '> Said **this**\nafter')
  assert.equal(md('bq. Short'), '> Short')
  assert.equal(md('{panel:title=Note}\nBody\n{panel}'), '> **Note**\n> Body')
  // tables, with a link's | inside a cell; rows without a heading take the first row as one
  assert.equal(md('||A||B||\n|[x|https://x.test]|2|'), '| A | B |\n| --- | --- |\n| [x](https://x.test) | 2 |')
  assert.equal(md('|a|b|\n|c|'), '| a | b |\n| --- | --- |\n| c |  |')
  // rule, line break, emoticons; unknown macros stay
  assert.equal(md('one\\\\two\n----\n(/) done :)'), 'one\ntwo\n---\n✅ done 🙂')
  assert.equal(md('{toc} and {jira:PAY-1}'), '{toc} and {jira:PAY-1}')
  assert.equal(md(''), '')
})
