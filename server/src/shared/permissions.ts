// Jira's project permissions, and the lowest of Strand's three project roles that holds each (spec 0201). Strand keeps
// fixed roles and gives them what Jira's default permission scheme gives: "Administrators" is Strand's admin, "any user
// with access" is member (Strand's viewer reads and comments). The server checks these, the web app hides what would be
// refused; nothing else decides them. A change here is a change of who may do what: it needs its own spec.

export type Role = 'viewer' | 'member' | 'admin'
export type Permission =
  | 'browse' | 'createIssues' | 'editIssues' | 'transitionIssues' | 'assignIssues' | 'assignable' | 'linkIssues' | 'moveIssues'
  | 'deleteIssues' | 'modifyReporter' | 'manageWatchers' | 'viewWatchers'
  | 'addComments' | 'editOwnComments' | 'deleteOwnComments' | 'editAllComments' | 'deleteAllComments'
  | 'createAttachments' | 'deleteOwnAttachments' | 'deleteAllAttachments'
  | 'workOnIssues' | 'editOwnWorklogs' | 'deleteOwnWorklogs' | 'editAllWorklogs' | 'deleteAllWorklogs'
  | 'manageSprints' | 'administer' | 'archiveIssues'

interface Row {
  /** Jira's name for it */
  name: string
  /** Who holds it in Jira's default permission scheme */
  jira: 'any user with access' | 'Administrators' | 'none'
  /** The lowest Strand role that holds it; null: Strand doesn't have it yet (`spec` adds it) */
  role: Role | null
  /** The spec that changes or adds it */
  spec?: string
}

export const PERMISSIONS: Record<Permission, Row> = {
  browse:               { name: 'Browse projects',           jira: 'any user with access', role: 'viewer' },
  createIssues:         { name: 'Create issues',             jira: 'any user with access', role: 'member' },
  editIssues:           { name: 'Edit issues',               jira: 'any user with access', role: 'member' },
  transitionIssues:     { name: 'Transition issues',         jira: 'any user with access', role: 'member' },
  assignIssues:         { name: 'Assign issues',             jira: 'any user with access', role: 'member' },
  assignable:           { name: 'Assignable user',           jira: 'any user with access', role: 'viewer', spec: '0207' },
  linkIssues:           { name: 'Link issues',               jira: 'any user with access', role: 'member' },
  moveIssues:           { name: 'Move issues',               jira: 'any user with access', role: null, spec: '0501' },
  deleteIssues:         { name: 'Delete issues',             jira: 'Administrators',       role: 'member', spec: '0202' },
  modifyReporter:       { name: 'Modify reporter',           jira: 'Administrators',       role: null, spec: '0207' },
  manageWatchers:       { name: 'Manage watchers',           jira: 'Administrators',       role: null, spec: '0207' },
  viewWatchers:         { name: 'View voters and watchers',  jira: 'any user with access', role: 'viewer' },
  addComments:          { name: 'Add comments',              jira: 'any user with access', role: 'viewer' },
  editOwnComments:      { name: 'Edit own comments',         jira: 'any user with access', role: 'viewer' },
  deleteOwnComments:    { name: 'Delete own comments',       jira: 'any user with access', role: 'viewer' },
  editAllComments:      { name: 'Edit all comments',         jira: 'Administrators',       role: null, spec: '0205' },
  deleteAllComments:    { name: 'Delete all comments',       jira: 'Administrators',       role: null, spec: '0205' },
  createAttachments:    { name: 'Create attachments',        jira: 'any user with access', role: 'member' },
  deleteOwnAttachments: { name: 'Delete own attachments',    jira: 'any user with access', role: 'member' },
  deleteAllAttachments: { name: 'Delete all attachments',    jira: 'Administrators',       role: 'member', spec: '0204' },
  workOnIssues:         { name: 'Work on issues',            jira: 'any user with access', role: 'member' },
  editOwnWorklogs:      { name: 'Edit own work logs',        jira: 'any user with access', role: 'member' },
  deleteOwnWorklogs:    { name: 'Delete own work logs',      jira: 'any user with access', role: 'member' },
  editAllWorklogs:      { name: 'Edit all work logs',        jira: 'Administrators',       role: 'admin' },
  deleteAllWorklogs:    { name: 'Delete all work logs',      jira: 'Administrators',       role: 'admin' },
  manageSprints:        { name: 'Manage sprints',            jira: 'Administrators',       role: 'member', spec: '0203' },
  administer:           { name: 'Administer projects',       jira: 'Administrators',       role: 'admin' },
  archiveIssues:        { name: 'Archive issues',            jira: 'none',                 role: null, spec: '0508' },
}

const RANK: Record<Role, number> = { viewer: 1, member: 2, admin: 3 }

/** Does someone with `role` in a project (null: none, or a workspace kept in the browser when `local`) hold `permission`? */
export function holds(role: Role | null | undefined, permission: Permission): boolean {
  const need = PERMISSIONS[permission].role
  if (!need || !role) return false
  return RANK[role] >= RANK[need]
}

/** The roles that hold a permission (for SQL: `role = any(...)`). */
export const rolesWith = (permission: Permission): Role[] => (['viewer', 'member', 'admin'] as Role[]).filter(r => holds(r, permission))
