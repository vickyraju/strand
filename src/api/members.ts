// Who is in a project and what they may do there (server only: a local workspace has no access control).
import { api } from './client'

export type ProjectRole = 'admin' | 'member' | 'viewer'
export interface ProjectMember { userId: string; name: string; email: string; initials: string; color: string; title: string | null; role: ProjectRole; addedAt: string }

export const ROLES: { id: ProjectRole; label: string; can: string }[] = [
  { id: 'admin',  label: 'Admin',  can: 'Manage the project’s settings, workflow and people, plus everything a member can do.' },
  { id: 'member', label: 'Member', can: 'Create, edit, move and comment on work items.' },
  { id: 'viewer', label: 'Viewer', can: 'See the project and comment. Cannot change work items.' },
]

const base = (key: string) => `/api/projects/${encodeURIComponent(key)}/members`
export const listMembers = (key: string) => api<ProjectMember[]>('GET', base(key))
export const addMembers = (key: string, userIds: string[], role: ProjectRole) => api<ProjectMember[]>('POST', base(key), { userIds, role })
export const setMemberRole = (key: string, userId: string, role: ProjectRole) =>
  api<ProjectMember>('PATCH', `${base(key)}/${userId}`, { role }).then(() => listMembers(key))   // the reply is just the one person; show the whole list
export const removeMember = (key: string, userId: string) => api<void>('DELETE', `${base(key)}/${userId}`)

// Groups from the organisation's directory: a role given to a group reaches everyone in it.
export interface ProjectGroup { groupId: string; name: string; role: ProjectRole; addedAt: string; members: number }
export interface GroupHit { id: string; name: string; members: number }

const groupsOf = (key: string) => `/api/projects/${encodeURIComponent(key)}/groups`
export const listGroups = (key: string) => api<ProjectGroup[]>('GET', groupsOf(key))
export const searchGroups = (query: string) => api<GroupHit[]>('GET', `/api/groups/search?query=${encodeURIComponent(query)}`)
export const addGroup = (key: string, groupId: string, role: ProjectRole) => api<ProjectGroup[]>('POST', groupsOf(key), { groupId, role })
export const setGroupRole = (key: string, groupId: string, role: ProjectRole) => api<ProjectGroup[]>('PATCH', `${groupsOf(key)}/${groupId}`, { role })
export const removeGroup = (key: string, groupId: string) => api<void>('DELETE', `${groupsOf(key)}/${groupId}`)
