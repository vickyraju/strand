// The announcement banner's schedule (spec 0701 R6), shared by the server (the login page) and the app.

/** Is the banner's schedule open at this moment (spec 0701 R6)? No times: always. */
export const scheduledNow = (a: { startsAt?: string | null; endsAt?: string | null }, now = Date.now()) =>
  (!a.startsAt || Date.parse(a.startsAt) <= now) && (!a.endsAt || now < Date.parse(a.endsAt))
