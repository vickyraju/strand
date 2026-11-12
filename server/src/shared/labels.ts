// Labels as in Jira (spec 0307): one word, no spaces, at most 255 characters. Shared by the server and the app.
import { z } from 'zod'

export const label = z.string().min(1).max(255, 'A label is at most 255 characters').regex(/^\S+$/, 'A label is one word: no spaces')
export const labels = z.array(label).max(50)

/** What someone typed as labels: spaces, commas and semicolons separate them; duplicates go. */
export const splitLabels = (text: string) => [...new Set(text.split(/[\s,;]+/).filter(Boolean))]
