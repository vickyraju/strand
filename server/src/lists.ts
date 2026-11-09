// Priorities and resolutions: lists an administrator edits, per workspace, as in Jira (spec 0305). Work items, templates
// and rules hold a priority's key and a resolution's name; these check them against the list.
import { HttpError } from './auth.ts'
import type { Db } from './db.ts'

export interface PriorityRow { key: string; name: string; description: string; color: string; icon: string; position: number; isDefault: boolean }
export interface ResolutionRow { id: string; name: string; description: string; position: number; isDefault: boolean }

export const priorities = (d: Db, ws: string) =>
  d.query<PriorityRow>('select key, name, description, color, icon, position, is_default from priorities where workspace_id = $1 order by position, key', [ws])
export const resolutions = (d: Db, ws: string) =>
  d.query<ResolutionRow>('select id, name, description, position, is_default from resolutions where workspace_id = $1 order by position, name', [ws])

/** The priority new work gets when none is chosen (Medium out of the box). */
export async function defaultPriority(d: Db, ws: string) {
  const [p] = await d.query<{ key: string }>('select key from priorities where workspace_id = $1 order by is_default desc, position limit 1', [ws])
  return p?.key ?? 'medium'
}

/** 400 unless the priority is one of the workspace's. */
export async function checkPriority(d: Db, ws: string, key: string | undefined | null, field = 'priority') {
  if (key == null) return
  if (!(await d.query('select 1 from priorities where workspace_id = $1 and key = $2', [ws, key])).length)
    throw new HttpError(400, 'That priority isn’t in the list (Administration › Priorities)', { [field]: 'Unknown priority' })
}

/** 400 unless the resolution is one of the workspace's. */
export async function checkResolution(d: Db, ws: string, name: string | undefined | null) {
  if (name == null) return
  if (!(await d.query('select 1 from resolutions where workspace_id = $1 and name = $2', [ws, name])).length)
    throw new HttpError(400, 'That resolution isn’t in the list (Administration › Resolutions)', { resolution: 'Unknown resolution' })
}
