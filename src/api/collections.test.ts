import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCollectionSync } from './collections.ts'
import { idle } from './queue.ts'

interface Item { id: string; text: string; parent: string }
const setup = (over: Record<string, unknown> = {}) => {
  const log: string[] = []; const errors: string[] = []; let recovered = 0
  const sync = createCollectionSync<Item>({
    id: i => i.id, changed: (a, b) => a.text !== b.text,
    create: async i => { log.push(`create ${i.id}:${i.text}`) },
    update: async (a, b) => { log.push(`update ${b.id}:${a.text}->${b.text}`) },
    remove: async i => { log.push(`remove ${i.id}`) },
    recover: async () => { recovered++ }, onError: m => errors.push(m), ...over,
  })
  return { sync, log, errors, recovered: () => recovered }
}
const it = (id: string, text = 't', parent = 'p') => ({ id, text, parent })

test('new records are created once, edits are updates, missing records are removed', async () => {
  const h = setup()
  h.sync.flush([it('a')]); h.sync.flush([it('a')])                   // flushing the same list twice sends once
  h.sync.flush([it('a', 'edited'), it('b')])
  h.sync.flush([it('b')])
  await idle()
  assert.deepEqual(h.log, ['create a:t', 'update a:t->edited', 'create b:t', 'remove a'])
})

test('records loaded from the server are not sent back; scoped load only replaces its scope', async () => {
  const h = setup()
  h.sync.load([it('a', 't', 'p1'), it('b', 't', 'p2')])
  h.sync.flush([it('a', 't', 'p1'), it('b', 't', 'p2')]); await idle()
  assert.deepEqual(h.log, [])
  h.sync.load([it('c', 't', 'p1')], t => t.parent === 'p1')           // reload p1 only: a is forgotten, b is kept
  h.sync.flush([it('c', 't', 'p1'), it('b', 't', 'p2')]); await idle()
  assert.deepEqual(h.log, [])
  h.sync.flush([it('c', 't', 'p1')]); await idle()                    // b really removed
  assert.deepEqual(h.log, ['remove b'])
})

test('shouldDelete can veto a server delete', async () => {
  const h = setup({ shouldDelete: (i: Item) => i.parent !== 'gone' })
  h.sync.flush([it('a', 't', 'gone'), it('b')]); h.sync.flush([])
  await idle()
  assert.deepEqual(h.log, ['create a:t', 'create b:t', 'remove b'])
})

test('a failure reports once, reloads, and drops work queued behind it', async () => {
  const h = setup({ create: async () => { throw new Error('boom') } })
  h.sync.flush([it('a')]); h.sync.flush([it('a'), it('b')])
  await idle()
  assert.deepEqual(h.errors, ['boom'])
  assert.equal(h.recovered(), 1)
  assert.deepEqual(h.log, [])
})
