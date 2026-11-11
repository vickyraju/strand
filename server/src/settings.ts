// System settings: the policies a workspace administrator controls at runtime (like Jira's Administration › System),
// instead of numbers fixed in code or environment variables. Infrastructure and secrets (database, storage, CORS) stay
// in the environment, and sign-in methods in auth_config (authConfig.ts, spec 0711); everything else an admin might
// reasonably decide lives here.
//
// Each setting is one row in `system_settings` (workspace, key, jsonb). Its shape, default and description are declared
// once below. Reads go through a short cache, so every API pod sees a change within CACHE_MS without a restart.
import { z } from 'zod'
import { db, type Db } from './db.ts'
import { keyPatternOk } from './shared/projectKeys.ts'

const days = (max: number) => z.number().int().min(1).max(max)


/** Every setting an admin can change. `public`: shown to every signed-in person (the web app needs it to behave the same
 *  as the server, e.g. the attachment size limit); otherwise only admins can read it. */
export const SETTINGS = {
  rateLimiting: {
    label: 'Rate limiting',
    description: 'Limits how many API requests each person can make from scripts and integrations, whatever they sign in with (access tokens, Microsoft or login sessions). Strand’s own web app is never limited. Requests without a sign-in count together as Anonymous. Off until you turn it on.',
    public: false,
    schema: z.object({
      enabled: z.boolean().describe('Off: no limits at all'),
      mode: z.enum(['limit', 'unlimited', 'block']).describe('limit: the numbers below; unlimited: count but never refuse; block: refuse every token request'),
      requests: z.number().int().min(1).max(1_000_000).describe('Requests allowed per interval'),
      intervalSeconds: z.number().int().min(1).max(86_400).describe('The interval, in seconds'),
      burst: z.number().int().min(1).max(10_000_000).describe('Most unused requests that can build up (at least the requests allowed)'),
      exemptions: z.array(z.object({
        userId: z.union([z.string().uuid(), z.literal('anonymous')]).describe('A person, or anonymous for every request without a sign-in (spec 0706)'),
        mode: z.enum(['limit', 'unlimited', 'block']),
        requests: z.number().int().min(1).max(1_000_000).optional(),
        intervalSeconds: z.number().int().min(1).max(86_400).optional(),
        burst: z.number().int().min(1).max(10_000_000).optional(),
      })).max(500).describe('People whose tokens get their own setting, overriding the one above'),
    }).refine(v => v.burst >= v.requests, { message: 'Max requests must be at least the requests allowed', path: ['burst'] }),
    default: { enabled: false, mode: 'limit', requests: 100, intervalSeconds: 60, burst: 100, exemptions: [] },
  },
  announcement: {
    label: 'Announcement banner',
    description: 'A message at the top of every page (Jira’s announcement banner). Public: also on the login page. Plain text; https:// addresses become links. Empty: no banner.',
    public: true,
    schema: z.object({
      text: z.string().max(2000).describe('The announcement; empty for none'),
      visibility: z.enum(['public', 'private']).describe('public: everyone, also on the login page; private: people signed in'),
    }),
    default: { text: '', visibility: 'private' },
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
      viewsMaxItems: z.number().int().min(1).max(10_000).default(1000).describe('Most work items in an XML, RSS, Word or printable export (Jira’s jira.search.views.default.max)'),
    }),
    default: { exportMaxRows: 20_000, bulkMaxItems: 200, importMaxRows: 10_000, viewsMaxItems: 1000 },
  },
  filterSubscriptions: {
    label: 'Filter subscriptions',
    description: 'Saved views emailed on a schedule (spec 0604): how many work items one email lists. Who may subscribe a group is the Manage group filter subscriptions global permission (spec 0717).',
    public: true,
    schema: z.object({
      maxItems: z.number().int().min(1).max(1000).describe('Most work items listed in one email'),
    }),
    default: { maxItems: 200 },
  },
  plans: {
    label: 'Plans',
    description: 'How many work items one plan shows at most (spec 0803), as Jira’s plans: 5,000 by default.',
    public: true,
    schema: z.object({ maxItems: z.number().int().min(100).max(20_000).describe('Most work items in one plan') }),
    default: { maxItems: 5000 },
  },
  sprints: {
    label: 'Sprints',
    description: 'Parallel sprints (Jira’s Jira Software configuration): a Scrum board can have more than one active sprint, for example two teams working from one backlog. It can’t be turned off while a board has more than one active sprint (spec 0414).',
    public: true,
    schema: z.object({ parallel: z.boolean().describe('More than one active sprint on a board') }),
    default: { parallel: false },
  },
  search: {
    label: 'Search',
    description: 'The indexing language of text search (~), as Jira’s: words are found in any of their forms (customize finds customized) and common words are left out. Other: exact words, no common words left out. A change re-indexes every work item and comment in the background (spec 0609).',
    public: false,
    schema: z.object({ indexingLanguage: z.enum(['arabic', 'armenian', 'basque', 'catalan', 'danish', 'dutch', 'english', 'finnish', 'french', 'german', 'greek', 'hindi', 'hungarian',
      'indonesian', 'irish', 'italian', 'lithuanian', 'nepali', 'norwegian', 'portuguese', 'romanian', 'russian', 'serbian', 'spanish', 'swedish', 'tamil', 'turkish', 'yiddish', 'other'])
      .describe('Jira’s Indexing language; Other turns stemming off') }),
    default: { indexingLanguage: 'english' },
  },
  signIn: {
    label: 'Sign-in',
    description: 'Sign-ins through the login form: how long one lasts, and how many wrong passwords lock a username for a while (Administration › Authentication methods).',
    public: false,
    schema: z.object({
      maxFailures: z.number().int().min(1).max(20).describe('Wrong passwords before the username is locked'),
      lockMinutes: z.number().int().min(1).max(1440).describe('How long the username stays locked'),
      sessionIdleMinutes: z.number().int().min(5).max(10_080).describe('A sign-in ends after this long unused'),
      rememberDays: z.number().int().min(1).max(365).describe('“Remember my login on this computer” keeps it this many days'),
      passwordMinLength: z.number().int().min(1).max(128).describe('Shortest password for people in the internal directory (spec 0714)'),
    }),
    default: { maxFailures: 3, lockMinutes: 5, sessionIdleMinutes: 300, rememberDays: 14, passwordMinLength: 8 },
  },
  groups: {
    label: 'Groups',
    description: 'Who may make groups. A group’s owners decide who is in it; project admins decide what a group may do in their project.',
    public: true,
    schema: z.object({ whoCanCreate: z.enum(['everyone', 'admins']).describe('Who may make a group: everyone, or system administrators only') }),
    default: { whoCanCreate: 'everyone' as 'everyone' | 'admins' },
  },
  voting: {
    label: 'Voting',
    description: 'Whether people can vote for work items, as Jira’s Voting option. Turned off, votes are kept but nobody can vote.',
    public: true,
    schema: z.object({ enabled: z.boolean() }),
    default: { enabled: true },
  },
  webhooks: {
    label: 'Webhooks',
    description: 'The ids your Jira gave Jira Software’s fields, so webhooks carry them under the same keys and integrations built for Jira read them unchanged. Find them in Jira under Administration › Issues › Custom fields.',
    public: false,
    schema: z.object({
      fieldIds: z.object(Object.fromEntries((['sprint', 'epicLink', 'epicName', 'epicStatus', 'epicColour', 'storyPoints', 'rank', 'flagged'] as const)
        .map(k => [k, z.string().regex(/^customfield_\d{1,9}$/, 'Like customfield_10100')])) as Record<'sprint' | 'epicLink' | 'epicName' | 'epicStatus' | 'epicColour' | 'storyPoints' | 'rank' | 'flagged', z.ZodString>),
    }),
    default: { fieldIds: { sprint: 'customfield_10100', epicLink: 'customfield_10101', epicStatus: 'customfield_10102', epicName: 'customfield_10103',
      epicColour: 'customfield_10104', rank: 'customfield_10105', storyPoints: 'customfield_10106', flagged: 'customfield_10107' } },
  },
  automation: {
    label: 'Automation',
    description: 'Limits for scheduled automation rules: how often one may run, and how many work items one run acts on.',
    public: false,
    schema: z.object({
      minScheduleMinutes: z.number().int().min(1).max(1440).describe('Shortest interval a scheduled rule may have, in minutes'),
      maxItemsPerRun: z.number().int().min(1).max(100_000).describe('Most work items one scheduled run acts on; the rest wait for the next run'),
    }),
    default: { minScheduleMinutes: 5, maxItemsPerRun: 1000 },
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
  emailBatching: {
    label: 'Batched email notifications',
    description: 'As Jira 8’s: a person’s notification emails about one work item wait for the window, then go as one email; @mentions go at once (spec 0606).',
    public: false,
    schema: z.object({
      enabled: z.boolean().describe('Batch notification emails'),
      minutes: z.number().int().min(1).max(1440).describe('How long changes to one work item are gathered'),
    }),
    default: { enabled: false, minutes: 10 },
  },
  userDefaults: {
    label: 'Default user preferences',
    description: 'What each person starts with until they choose in Settings › Notifications, as Jira’s Default User Preferences (spec 0606).',
    public: true,
    schema: z.object({
      autowatch: z.boolean().describe('Watch work you create or comment on'),
      notifyOwnChanges: z.boolean().describe('Hear about your own changes'),
    }),
    default: { autowatch: true, notifyOwnChanges: false },
  },
  deletedItems: {
    label: 'Deleted work items',
    description: 'How long a deleted work item can be restored (Project settings › Deleted work items) before it is removed for good.',
    public: false,
    schema: z.object({ retentionDays: z.number().int().min(1).max(365).describe('Days a deleted work item is kept') }),
    default: { retentionDays: 30 },
  },
  projectKeys: {
    label: 'Project keys',
    description: 'What a new project’s key may look like (Jira’s project key pattern and maximum key size). Existing keys are kept; a new pattern must still fit them.',
    public: true,
    schema: z.object({
      pattern: z.string().trim().min(1).max(200).refine(keyPatternOk, 'Use a pattern that compiles, starts keys with a capital letter and allows only A–Z, 0–9 and _')
        .describe('A regular expression a whole key must match, such as [A-Z][A-Z]+ (Jira’s default)'),
      maxLength: z.number().int().min(2).max(255).describe('Longest key, in characters'),
    }),
    default: { pattern: '[A-Z][A-Z]+', maxLength: 10 },
  },
  timeTracking: {
    label: 'Time tracking',
    description: 'How long a day and a week of work are, how time is shown, and what a number typed without a unit means (Jira’s time tracking settings). Stored times don’t change.',
    public: true,
    schema: z.object({
      hoursPerDay: z.number().min(1).max(24).describe('Working hours in a day: how long “1d” is'),
      daysPerWeek: z.number().min(1).max(7).describe('Working days in a week: how long “1w” is'),
      format: z.enum(['pretty', 'days', 'hours']).describe('pretty: 1w 2d 3h 30m; days: 1.5d; hours: 12h'),
      defaultUnit: z.enum(['m', 'h', 'd', 'w']).describe('The unit of a number typed without one'),
    }),
    default: { hoursPerDay: 8, daysPerWeek: 5, format: 'pretty', defaultUnit: 'm' },
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
