import re, os, glob, subprocess, sys
root = sys.argv[1]
os.chdir(root)
# every test file's text, once
blob = ''
for pat in ['server/test/**/*.ts', 'src/**/*.test.ts', 'e2e/**/*.mjs', 'scripts/**/*.test.mjs']:
    for f in glob.glob(pat, recursive=True):
        blob += open(f).read() + '\n'
readme = open('docs/specs/README.md').read()
status = dict(re.findall(r'^\| \[(\d{4})\]\([^)]*\) \| [^|]+\| [^|]+\| ([^|]+?) \|', readme, re.M))
rows = []
for f in sorted(glob.glob('docs/specs/0*.md')):
    n = os.path.basename(f)[:4]
    s = open(f).read()
    if '## Rules' not in s: continue
    rules_sec = s[s.index('## Rules'):]
    nxt = re.search(r'\n## ', rules_sec[3:])
    rules_sec = rules_sec[:nxt.start()+3] if nxt else rules_sec
    rules = sorted(set(int(x) for x in re.findall(r'\*\*R(\d+)\b', rules_sec)))
    withdrawn = set(int(x) for x in re.findall(r'\*\*R(\d+)[^\n]*withdrawn', rules_sec, re.I))
    missing = [r for r in rules if r not in withdrawn and not re.search(rf'{n}\.R{r}\b', blob)]
    rows.append((n, status.get(n, '?').strip(), len(rules), missing))
ok = [r for r in rows if not r[3]]
print(f'specs with rules: {len(rows)}; every rule covered: {len(ok)}')
for n, st, total, miss in rows:
    if miss: print(f'{n} [{st}] {total} rules; no test cites: ' + ', '.join(f'R{m}' for m in miss))
