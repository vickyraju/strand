// One ordered queue for every request the app sends to the API, whichever sync module made it. Sharing it keeps
// related writes in the order they were made (a sprint exists before an issue is put in it, an issue before its comment).
let chain: Promise<void> = Promise.resolve()

/** Runs `job` after everything queued before it. A job that throws must handle its own error. */
export const enqueue = (job: () => Promise<void>) => { chain = chain.then(job) }

/** Resolves when everything queued so far has finished (used by tests, and before sign-out). */
export const idle = () => chain
