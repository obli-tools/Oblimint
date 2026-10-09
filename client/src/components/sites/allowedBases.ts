// Pure helpers: the plan's allowedBases on the client (no runtime imports:
// unit-tested from a node harness). The SERVER stays the authority
// (409 baseNotAllowed); this only keeps the UI from offering refused bases.

/** A base id is allowed when the plan has no list (null / undefined) or lists it. */
export function isBaseAllowed<B extends string>(allowed: readonly B[] | null | undefined, base: B): boolean {
  return !allowed || allowed.includes(base);
}

/**
 * Base to preselect: `preferred` when allowed, otherwise the first allowed
 * base of `catalog` (maintained ones first), otherwise `preferred` unchanged
 * (empty / inconsistent list: the server answers with a clear error).
 */
export function pickAllowedBase<B extends string>(
  allowed: readonly B[] | null | undefined,
  preferred: B,
  catalog: ReadonlyArray<{ id: B; unmaintained?: boolean }>,
): B {
  if (isBaseAllowed(allowed, preferred)) return preferred;
  const usable = catalog.filter((b) => isBaseAllowed(allowed, b.id));
  return (usable.find((b) => !b.unmaintained) ?? usable[0])?.id ?? preferred;
}
