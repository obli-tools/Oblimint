import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MigrationAccountChoice, MigrationPlan, MigrationPlanChoices } from '@oblimint/shared';
import { migrationApi } from '@/api/migration.api';
import { toastMigrationError } from '../migrationUi';

// Editing state of a plan (docs/P5-PLAN.md §8.1): every write of the choices
// recomputes the dry-run server side and answers the whole plan. Account
// choices are written debounced (the full choice object of that account is
// PUT: the route replaces it). EVERY write of the plan (account choices,
// global / packages / orphan zones, compute) goes through ONE client queue so
// the answers are applied in the order the server committed them, and a plan
// older than the one already applied (updatedAt) is ignored (socket reloads
// included, see isNewerPlan). OWNED BY MODULE `ui-migration`.

const ACCOUNT_DEBOUNCE_MS = 700;

/** Plan-level parts written through PUT /choices (the accounts map always comes from the latest plan + the drafts). */
export type PlanChoicesPatch = Partial<Pick<MigrationPlanChoices, 'global' | 'packages' | 'orphanZones'>>;

/**
 * Plan-level sections edited as a form and saved by an explicit « Save and
 * recompute » (overview = global, packages). Their drafts live in the editor,
 * not in the tab: switching tab keeps them, and they count in pendingCount
 * (header badge + beforeunload guard).
 */
export type PlanSection = 'global' | 'packages';
export type SectionDrafts = { [K in PlanSection]?: MigrationPlanChoices[K] };

/** Sections whose draft differs from the stored choices. */
export function dirtySections(drafts: SectionDrafts, choices: MigrationPlanChoices | null | undefined): PlanSection[] {
  const out: PlanSection[] = [];
  for (const k of Object.keys(drafts) as PlanSection[]) {
    const d = drafts[k];
    if (d !== undefined && JSON.stringify(d) !== JSON.stringify(choices?.[k] ?? null)) out.push(k);
  }
  return out;
}

/** True when `next` may replace `cur` (another plan, or a write not older than the applied one). */
export function isNewerPlan(next: MigrationPlan, cur: MigrationPlan | null): boolean {
  if (!cur || cur.id !== next.id) return true;
  const a = Date.parse(next.updatedAt);
  const b = Date.parse(cur.updatedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return a >= b;
}

export interface PlanEditor {
  plan: MigrationPlan;
  /** Account choice as currently edited (local draft first, then the stored choice). */
  accountChoice: (username: string) => MigrationAccountChoice;
  editAccount: (username: string, update: (cur: MigrationAccountChoice) => MigrationAccountChoice) => void;
  /** Same update on several accounts, written at once (one PUT /choices, one recompute). */
  editAccounts: (usernames: string[], update: (cur: MigrationAccountChoice) => MigrationAccountChoice) => void;
  /** Usernames whose choice is being written. */
  saving: ReadonlySet<string>;
  /** Usernames whose last write failed (the draft is kept on screen, not saved). */
  failed: ReadonlySet<string>;
  /** Number of drafts not saved yet: account drafts (debounced, queued, in flight or failed) + dirty plan sections. */
  pendingCount: number;
  /** Section as currently edited (draft first, then the stored choices). */
  sectionValue: <K extends PlanSection>(k: K) => MigrationPlanChoices[K];
  /** Replaces the draft of a section (not written: saveSection writes it). */
  setSection: <K extends PlanSection>(k: K, update: (cur: MigrationPlanChoices[K]) => MigrationPlanChoices[K]) => void;
  /** Drops the draft of a section (back to the stored choices). */
  resetSection: (k: PlanSection) => void;
  /** True when the draft of the section differs from the stored choices. */
  sectionDirty: (k: PlanSection) => boolean;
  /** Writes the draft of a section (PUT /choices + recompute); the draft is dropped once saved. */
  saveSection: (k: PlanSection) => Promise<boolean>;
  /** Write every pending account draft now. */
  flushAll: () => void;
  saveChoices: (patch: PlanChoicesPatch) => Promise<boolean>;
  savingChoices: boolean;
  compute: () => Promise<void>;
  computing: boolean;
  setPlan: (p: MigrationPlan) => void;
}

export function usePlanEditor(plan: MigrationPlan | null, setPlan: (p: MigrationPlan) => void): PlanEditor | null {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<Record<string, MigrationAccountChoice>>({});
  const [sections, setSections] = useState<SectionDrafts>({});
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [savingChoices, setSavingChoices] = useState(false);
  const [computing, setComputing] = useState(false);
  const timers = useRef(new Map<string, number>());
  const planId = plan?.id ?? null;
  // Latest plan applied (updated synchronously by the queue, not only on render).
  const latest = useRef<MigrationPlan | null>(plan);
  if (plan && isNewerPlan(plan, latest.current)) latest.current = plan;
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const tRef = useRef(t);
  tRef.current = t;

  const apply = useCallback((p: MigrationPlan) => {
    if (!isNewerPlan(p, latest.current)) return;
    latest.current = p;
    setPlan(p);
  }, [setPlan]);

  /** Serializes every write of the plan. */
  const enqueue = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(job, job);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  /** Drops the drafts that were sent and did not change meanwhile. */
  const settle = useCallback((sent: Record<string, MigrationAccountChoice>, ok: boolean) => {
    const users = Object.keys(sent);
    if (ok) {
      const drop = (cur: Record<string, MigrationAccountChoice>) => {
        let changed = false;
        const next = { ...cur };
        for (const u of users) if (next[u] === sent[u]) { delete next[u]; changed = true; }
        return changed ? next : cur;
      };
      draftsRef.current = drop(draftsRef.current);
      setDrafts(drop);
    }
    setFailed((cur) => {
      const n = new Set(cur);
      for (const u of users) { if (ok) n.delete(u); else n.add(u); }
      return n;
    });
  }, []);

  const writeAccount = useCallback((username: string): Promise<void> => {
    const prev = timers.current.get(username);
    if (prev) window.clearTimeout(prev);
    timers.current.delete(username);
    return enqueue(async () => {
      // Read the draft when the job runs: the newest edit is the one written.
      const choice = draftsRef.current[username];
      const id = latest.current?.id ?? null;
      if (!choice || id == null) return;
      setSaving((cur) => new Set(cur).add(username));
      try {
        apply(await migrationApi.setAccountChoice(id, username, choice));
        settle({ [username]: choice }, true);
      } catch (err) {
        settle({ [username]: choice }, false);
        toastMigrationError(tRef.current, err, tRef.current('migration.plan.saveFailed') || 'The choice could not be saved');
      } finally {
        setSaving((cur) => { const n = new Set(cur); n.delete(username); return n; });
      }
    });
  }, [apply, enqueue, settle]);

  const writeChoices = useCallback((patch: PlanChoicesPatch): Promise<boolean> => {
    // Pending account drafts go with this write (their timers are cancelled): the body is built from the latest plan.
    for (const u of [...timers.current.keys()]) { window.clearTimeout(timers.current.get(u)); timers.current.delete(u); }
    return enqueue(async () => {
      const cur = latest.current;
      if (!cur) return false;
      const sent = { ...draftsRef.current };
      const body: MigrationPlanChoices = { ...cur.choices, ...patch, accounts: { ...cur.choices.accounts, ...sent } };
      const users = Object.keys(sent);
      setSavingChoices(true);
      setSaving((s) => { const n = new Set(s); for (const u of users) n.add(u); return n; });
      try {
        apply(await migrationApi.setChoices(cur.id, body));
        settle(sent, true);
        return true;
      } catch (err) {
        settle(sent, false);
        toastMigrationError(tRef.current, err, tRef.current('migration.plan.saveFailed') || 'The choice could not be saved');
        return false;
      } finally {
        setSavingChoices(false);
        setSaving((s) => { const n = new Set(s); for (const u of users) n.delete(u); return n; });
      }
    });
  }, [apply, enqueue, settle]);

  const sectionValue = useCallback(<K extends PlanSection>(k: K): MigrationPlanChoices[K] => (
    (sections[k] as MigrationPlanChoices[K] | undefined) ?? (latest.current?.choices[k] as MigrationPlanChoices[K])
  ), [sections]);

  const setSection = useCallback(<K extends PlanSection>(k: K, update: (cur: MigrationPlanChoices[K]) => MigrationPlanChoices[K]) => {
    const base = (sectionsRef.current[k] as MigrationPlanChoices[K] | undefined) ?? (latest.current?.choices[k] as MigrationPlanChoices[K]);
    const next: SectionDrafts = { ...sectionsRef.current, [k]: update(base) };
    sectionsRef.current = next;
    setSections(next);
  }, []);

  const resetSection = useCallback((k: PlanSection) => {
    if (!(k in sectionsRef.current)) return;
    const next: SectionDrafts = { ...sectionsRef.current };
    delete next[k];
    sectionsRef.current = next;
    setSections(next);
  }, []);

  const saveSection = useCallback(async (k: PlanSection): Promise<boolean> => {
    const sent = sectionsRef.current[k];
    if (sent === undefined) return true;
    const ok = await writeChoices({ [k]: sent } as PlanChoicesPatch);
    // Dropped only when not edited again while the write was in flight.
    if (ok && sectionsRef.current[k] === sent) resetSection(k);
    return ok;
  }, [resetSection, writeChoices]);

  // Leaving the page (unmount) writes the edits still waiting for their debounce instead of dropping them.
  useEffect(() => () => {
    for (const u of [...timers.current.keys()]) void writeAccount(u);
  }, [writeAccount]);

  // Closing / reloading the tab with unsaved drafts: browser confirmation.
  const dirty = dirtySections(sections, plan?.choices);
  const pendingCount = Object.keys(drafts).length + dirty.length;
  useEffect(() => {
    if (pendingCount === 0) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [pendingCount]);

  const accountChoice = useCallback((username: string): MigrationAccountChoice => (
    drafts[username] ?? latest.current?.choices.accounts[username] ?? {}
  ), [drafts]);

  const editAccount = useCallback((username: string, update: (cur: MigrationAccountChoice) => MigrationAccountChoice) => {
    const base = draftsRef.current[username] ?? latest.current?.choices.accounts[username] ?? {};
    const next = update(base);
    draftsRef.current = { ...draftsRef.current, [username]: next };
    setDrafts((cur) => ({ ...cur, [username]: next }));
    const prev = timers.current.get(username);
    if (prev) window.clearTimeout(prev);
    timers.current.set(username, window.setTimeout(() => { void writeAccount(username); }, ACCOUNT_DEBOUNCE_MS));
  }, [writeAccount]);

  const editAccounts = useCallback((usernames: string[], update: (cur: MigrationAccountChoice) => MigrationAccountChoice) => {
    if (usernames.length === 0) return;
    const nextDrafts = { ...draftsRef.current };
    for (const u of usernames) nextDrafts[u] = update(nextDrafts[u] ?? latest.current?.choices.accounts[u] ?? {});
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    void writeChoices({});
  }, [writeChoices]);

  const flushAll = useCallback(() => {
    const users = Object.keys(draftsRef.current);
    if (users.length === 1) void writeAccount(users[0]);
    else if (users.length > 1) void writeChoices({});
  }, [writeAccount, writeChoices]);

  const compute = useCallback(async () => {
    if (planId == null) return;
    setComputing(true);
    try {
      await enqueue(async () => { apply(await migrationApi.computePlan(planId)); });
    } catch (err) {
      toastMigrationError(t, err, t('migration.plan.computeFailed') || 'The dry-run could not be computed');
    } finally {
      setComputing(false);
    }
  }, [apply, enqueue, planId, t]);

  const setPlanChecked = useCallback((p: MigrationPlan) => { latest.current = p; setPlan(p); }, [setPlan]);

  if (!plan) return null;
  return {
    plan, accountChoice, editAccount, editAccounts, saving, failed, pendingCount, flushAll,
    sectionValue, setSection, resetSection, sectionDirty: (k: PlanSection) => dirty.includes(k), saveSection,
    saveChoices: writeChoices, savingChoices, compute, computing, setPlan: setPlanChecked,
  };
}
