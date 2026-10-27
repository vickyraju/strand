// System settings: the policies a workspace administrator controls at runtime (like Jira's Administration › System),
// instead of numbers fixed in code or environment variables. Infrastructure and secrets (database, storage, sign-in,
// CORS) stay in the environment; everything an admin might reasonably decide lives here.
//
// Each setting is one row in `system_settings` (workspace, key, jsonb). Its shape, default and description are declared
// once below. Reads go through a short cache, so every API pod sees a change within CACHE_MS without a restart.
import { z } from 'zod'
import { db, type Db } from './db.ts'

const days = (max: number) => z.number().int().min(1).max(max)

/** Every setting an admin can change. `public`: shown to every signed-in person (the web app needs it to behave the same
 *  as the server, e.g. the attachment size limit); otherwise only admins can read it. */
export const SETTINGS = {
  rateLimiting: {
    label: 'Rate limiting',
    description: 'Limits how many API requests a person’s access tokens (scripts and integrations) can make. The web app is never limited. Off until you turn it on.',
    public: false,
    schema: z.object({
      enabled: z.boolean().describe('Off: no limits at all'),
      mode: z.enum(['limit', 'unlimited', 'block']).describe('limit: the numbers below; unlimited: count but never refuse; block: refuse every token request'),
      requests: z.number().int().min(1).max(1_000_000).describe('Requests allowed per interval'),
      intervalSeconds: z.number().int().min(1).max(86_400).describe('The interval, in seconds'),
      burst: z.number().int().min(1).max(10_000_000).describe('Most unused requests that can build up (at least the requests allowed)'),
      exemptions: z.array(z.object({
        userId: z.string().uuid(),
        mode: z.enum(['limit', 'unlimited', 'block']),
        requests: z.number().int().min(1).max(1_000_000).optional(),
        intervalSeconds: z.number().int().min(1).max(86_400).optional(),
        burst: z.number().int().min(1).max(10_000_000).optional(),
      })).max(500).describe('People whose tokens get their own setting, overriding the one above'),
    }).refine(v => v.burst >= v.requests, { message: 'Max requests must be at least the requests allowed', path: ['burst'] }),
    default: { enabled: false, mode: 'limit', requests: 100, intervalSeconds: 60, burst: 100, exemptions: [] },
  },
  attachments: {
    label: 'Attachments',
    description: 'Whether people can attach files to work items, and how large a file may be.',
    public: true,
    schema: z.object({ enabled: z.boolean(), maxSizeMb: z.number().int().min(1).max(2048).describe('Largest file, in MB') }),
    default: { enabled: true, maxSizeMb: 25 },
  },
  accessTokens: {
    label: 'Personal access tokens',
    description: 'Tokens people create for scripts and integrations.',
    public: true,
    schema: z.object({
      enabled: z.boolean().describe('Off: tokens cannot be created or used'),
      maxPerUser: z.number().int().min(1).max(100).describe('Active tokens one person may have'),
      maxExpiryDays: days(3650).describe('Longest lifetime a token may be given'),
      defaultExpiryDays: days(3650).describe('Lifetime offered when someone creates a token'),
    }).refine(v => v.defaultExpiryDays <= v.maxExpiryDays, { message: 'The default lifetime cannot be longer than the longest one', path: ['defaultExpiryDays'] }),
    default: { enabled: true, maxPerUser: 10, maxExpiryDays: 365, defaultExpiryDays: 90 },
  },
  searchAndBulk: {
    label: 'Search, export and bulk changes',
    description: 'How many work items one export, one bulk change or one CSV import can include.',
    public: true,
    schema: z.object({
      exportMaxRows: z.number().int().min(100).max(1_000_000).describe('Most work items in one CSV export'),
      bulkMaxItems: z.number().int().min(1).max(5000).describe('Most work items in one bulk change'),
      importMaxRows: z.number().int().min(10).max(100_000).describe('Most rows in one CSV import'),
    }),
    default: { exportMaxRows: 20_000, bulkMaxItems: 200, importMaxRows: 10_000 },
  },
  licenseCleanup: {
    label: 'License cleanup',
    description: 'People who haven’t used Strand for a while lose their seat (users-access) until they sign in again, or leave chosen groups, or are deactivated. Checked daily; they are warned first.',
    public: false,
    schema: z.object({
      enabled: z.boolean().describe('Run the cleanup every day'),
      inactiveDays: z.number().int().min(7).max(3650).describe('Inactive for this many days'),
      action: z.enum(['remove-access', 'remove-groups', 'deactivate']).describe('remove-access: out of users-access, back at their next sign-in; remove-groups: out of the chosen groups; deactivate: sign-in refused until reactivated'),
      groupIds: z.array(z.string().uuid()).max(50).describe('The groups for remove-groups'),
      warnDays: z.number().int().min(0).max(60).describe('Email a warning this many days before (0: none)'),
      excludedGroupIds: z.array(z.string().uuid()).max(50).describe('Members of these groups are never changed'),
      protectLeads: z.boolean().describe('Leave project and component leads alone'),
      reportTo: z.array(z.string().trim().email()).max(20).describe('Who gets a report of each run that changed someone'),
    }).refine(v => v.action !== 'remove-groups' || v.groupIds.length > 0, { path: ['groupIds'], message: 'Choose the groups to take people out of' })
      .refine(v => v.warnDays < v.inactiveDays, { path: ['warnDays'], message: 'Warn fewer days ahead than the inactivity period' }),
    default: { enabled: false, inactiveDays: 90, action: 'remove-access' as 'remove-access' | 'remove-groups' | 'deactivate', groupIds: [] as string[], warnDays: 7, excludedGroupIds: [] as string[], protectLeads: true, reportTo: [] as string[] },
  },
  groups: {
    label: 'Groups',
    description: 'Who may make groups. A group’s owners decide who is in it; project admins decide what a group may do in their project.',
    public: true,
    schema: z.object({ whoCanCreate: z.enum(['everyone', 'admins']).describe('Who may make a group: everyone, or system administrators only') }),
    default: { whoCanCreate: 'everyone' as 'everyone' | 'admins' },
  },
  testing: {
    label: 'Testing',
    description: 'How test results add up (Xray’s rule: whether a finished run outweighs a newer one that hasn’t finished), and how big a CI results import can be.',
    public: true,
    schema: z.object({
      finalStatusesHavePrecedence: z.boolean().describe('A test’s status is its latest finished result; a newer run still to do or under way doesn’t replace it. Off: the latest run counts, whatever its status'),
      resultImportMaxMb: z.number().int().min(1).max(20).default(10).describe('Largest CI results file, in MB'),
      resultImportMaxTests: z.number().int().min(10).max(20_000).default(2000).describe('Most test results in one import'),
    }),
    default: { finalStatusesHavePrecedence: true, resultImportMaxMb: 10, resultImportMaxTests: 2000 },
  },
  dueReminders: {
    label: 'Due dates',
    description: 'When people are reminded about work assigned to them that is due, and what counts as “due soon”.',
    public: true,
    schema: z.object({
      enabled: z.boolean().describe('Send “due” notifications at all'),
      daysAhead: z.number().int().min(0).max(30).describe('Remind this many days before the due date (0: on the day)'),
      daysLate: z.number().int().min(0).max(90).describe('Keep reminding for this many days after it is late'),
      dueSoonDays: z.number().int().min(1).max(30).describe('“Due soon” on Your work: due within this many days'),
    }),
    default: { enabled: true, daysAhead: 1, daysLate: 3, dueSoonDays: 3 },
  },
  email: {
    label: 'Email notifications',
    description: 'Whether people get their notifications by email too (each person chooses which, in Settings), and who the emails come from. Off until an admin turns it on; the platform team sets up the sending service.',
    public: false,
    schema: z.object({
      enabled: z.boolean().describe('Send notification emails'),
      from: z.string().trim().max(200).regex(/^$|^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$|^[^<>]*<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$/, 'An address like strand@example.com or “Strand <strand@example.com>”').describe('Sender, e.g. Strand <strand@example.com>'),
      appUrl: z.string().trim().max(300).regex(/^$|^https:\/\//, 'Starts with https://').describe('Address of the app, for links in emails'),
    }).refine(v => !v.enabled || !!v.from, { path: ['from'], message: 'Say who the emails come from' }),
    default: { enabled: false, from: '', appUrl: '' },
  },
  projectBackups: {
    label: 'Project backups',
    description: 'Whether deleting a project backs it up first, and where. Managed on the Project backups page.',
    public: false,
    ownRoutes: true,   // /admin/settings/project-backups: the bucket must be one the operators allow
    schema: z.object({ enabled: z.boolean(), bucket: z.string().optional(), prefix: z.string().optional() }),
    default: { enabled: true },
  },
} as const

export type SettingKey = keyof typeof SETTINGS
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]['schema']>
export const isSettingKey = (k: string): k is SettingKey => k in SETTINGS

/** How long a pod keeps a value before reading it again. */
export const CACHE_MS = 10_000
const cache = new Map<string, { value: unknown; at: number }>()

/** The setting's value for a workspace: what an admin saved, filled in with defaults for anything not saved. */
export async function getSetting<K extends SettingKey>(workspaceId: string, key: K, d: Db = db): Promise<SettingValue<K>> {
  const id = `${workspaceId}:${key}`
  const hit = cache.get(id)
  if (hit && Date.now() - hit.at < CACHE_MS && d === db) return hit.value as SettingValue<K>
  const [row] = await d.query<{ value: object }>('select value from system_settings where workspace_id = $1 and key = $2', [workspaceId, key])
  const value = { ...SETTINGS[key].default, ...(row?.value ?? {}) } as SettingValue<K>
  cache.set(id, { value, at: Date.now() })
  return value
}

/** Saves a setting (already validated). The caller writes the audit entry in the same transaction. */
export async function setSetting(d: Db, workspaceId: string, key: SettingKey, value: object, by: string) {
  await d.query(
    `insert into system_settings (workspace_id, key, value, updated_by) values ($1, $2, $3, $4)
     on conflict (workspace_id, key) do update set value = $3, updated_at = now(), updated_by = $4`,
    [workspaceId, key, JSON.stringify(value), by])
  cache.delete(`${workspaceId}:${key}`)
}

/** Forget cached values (tests change settings directly). */
export const clearSettingsCache = () => cache.clear()
