// Generic "send the difference" sync for a list of records (comments, sprints, settings items).
// Same idea as sync.ts: keep a base of what the server last saw, diff against the local list on every change,
// and send creates / updates / deletes through the shared ordered queue. A failure reloads from the server.
import { enqueue } from './queue.ts'

export interface CollectionOptions<T> {
  id: (t: T) => string
  /** True when `after` differs from `before` in something the server stores. */
  changed: (before: T, after: T) => boolean
  create: (t: T) => Promise<void>
  update: (before: T, after: T) => Promise<void>
  remove: (t: T) => Promise<void>
  /** Return false for a record that vanished locally because its parent did: no server delete, and it stays in the base. */
  shouldDelete?: (t: T) => boolean
  /** Reload this collection from the server and put it in the store. */
  recover: () => Promise<void>
  onError: (message: string) => void
}

export function createCollectionSync<T>(o: CollectionOptions<T>) {
  const base = new Map<string, T>()
  let epoch = 0

  const run = (job: () => Promise<void>) => {
    const mine = epoch
    enqueue(async () => {
      if (mine !== epoch) return                    // queued before a failure that already reloaded everything
      try { await job() } catch (e) {
        epoch++
        o.onError(e instanceof Error ? e.message : 'Could not save your change')
        try { await o.recover() } catch { /* offline: the next change retries */ }
      }
    })
  }

  return {
    /** Records that came from the server become the base, so they are never sent back. `inScope` limits what is replaced. */
    load(items: T[], inScope: (t: T) => boolean = () => true) {
      for (const [id, t] of base) if (inScope(t)) base.delete(id)
      for (const t of items) base.set(o.id(t), t)
    },
    /** `only` splits a flush in two so other syncs can run between: 'writes' = creates and updates, 'deletes' = removals.
     *  (A status must be deleted after its issues are moved off it, but created before issues move onto it.) */
    flush(current: T[], only?: 'writes' | 'deletes') {
      const seen = new Set<string>()
      for (const t of current) {
        const id = o.id(t); seen.add(id)
        if (only === 'deletes') continue
        const was = base.get(id)
        base.set(id, t)
        if (!was) run(() => o.create(t))
        else if (o.changed(was, t)) run(() => o.update(was, t))
      }
      if (only === 'writes') return
      for (const [id, t] of [...base]) {
        if (seen.has(id)) continue
        // Gone locally only because its parent went (an issue or project that Undo can bring back): leave it
        // in the base, so when it returns it is recognised as unchanged and not created a second time.
        if (!(o.shouldDelete?.(t) ?? true)) continue
        base.delete(id)
        run(() => o.remove(t))
      }
    },
    has: (id: string) => base.has(id),
  }
}
