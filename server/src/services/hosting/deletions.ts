// Site deletions running in THIS process (the panel is one process): the
// sites table has no 'deleting' state, so hosting-api (DELETE /sites/:id) and
// the release pipeline (no publish / rollback / approval while the site is
// being torn down) share this set. A failed deletion leaves the site in
// 'error' and can be retried.
const inFlight = new Set<number>();

export const siteDeletions = {
  has: (siteId: number): boolean => inFlight.has(siteId),
  add: (siteId: number): void => { inFlight.add(siteId); },
  delete: (siteId: number): void => { inFlight.delete(siteId); },
};
