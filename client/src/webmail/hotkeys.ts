import { useEffect, useRef } from 'react';

// Keyboard shortcuts of the webmail (Outlook / Gmail style, the Oblidesk
// palette on Ctrl+K). A key is ignored while the user types (input, textarea,
// select, contenteditable), with Ctrl / Alt / Meta held (except the combos
// listed with a "mod+" prefix), and while a modal layer is open unless the
// handler says otherwise.

/** A handler returning `false` did not handle the key: the browser's default action is kept. */
export type HotkeyMap = Record<string, (e: KeyboardEvent) => void | boolean>;

/** Attribute on the composer's root: single-key shortcuts never act from inside it. */
export const COMPOSER_ATTR = 'data-wm-composer';

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable;
}

function inComposer(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.(`[${COMPOSER_ATTR}]`);
}

/**
 * Name of a key event as written in a HotkeyMap: "j", "shift+3" → "#",
 * "mod+k", "escape", "delete". AltGr (reported as Ctrl + Alt on Windows)
 * types a symbol on many layouts ("#" is AltGr+3 in AZERTY): a printed
 * symbol typed with it counts as that plain key; a letter or digit with
 * Ctrl + Alt is no shortcut.
 */
export function hotkeyName(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'> & { getModifierState?: (k: string) => boolean }): string | null {
  const key = e.key.toLowerCase();
  const altGr = !!e.getModifierState?.('AltGraph') || (e.ctrlKey && e.altKey);
  if (altGr) return key.length === 1 && !/[\p{L}\p{N}\s]/u.test(key) ? key : null;
  if (e.altKey) return null;
  if (e.ctrlKey || e.metaKey) return `mod+${key}`;
  return key;
}

/**
 * Global shortcuts. `enabled` false: none; only "mod+" combos fire while
 * typing or from inside the composer (Escape in a field is the field's: the
 * search clears itself, the composer keeps its draft; Ctrl+Enter is handled
 * by the composer itself).
 */
export function useHotkeys(map: HotkeyMap, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const name = hotkeyName(e);
      if (!name) return;
      const fn = ref.current[name];
      if (!fn) return;
      if ((typing(e.target) || inComposer(e.target)) && !name.startsWith('mod+')) return;
      if (fn(e) !== false) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/** Shortcut list shown by the "?" dialog (label keys + fallbacks resolved by the caller). */
export const SHORTCUTS: Array<{ keys: string[]; key: string; fallback: string }> = [
  { keys: ['C'], key: 'wm.keys.compose', fallback: 'New message' },
  { keys: ['/'], key: 'wm.keys.search', fallback: 'Search' },
  { keys: ['J'], key: 'wm.keys.next', fallback: 'Next conversation' },
  { keys: ['K'], key: 'wm.keys.previous', fallback: 'Previous conversation' },
  { keys: ['R'], key: 'wm.keys.reply', fallback: 'Reply' },
  { keys: ['A'], key: 'wm.keys.replyAll', fallback: 'Reply all' },
  { keys: ['F'], key: 'wm.keys.forward', fallback: 'Forward' },
  { keys: ['E'], key: 'wm.keys.archive', fallback: 'Archive' },
  { keys: ['#', 'Del'], key: 'wm.keys.delete', fallback: 'Delete' },
  { keys: ['U'], key: 'wm.keys.unread', fallback: 'Mark as read / unread' },
  { keys: ['S'], key: 'wm.keys.flag', fallback: 'Flag / unflag' },
  { keys: ['X'], key: 'wm.keys.select', fallback: 'Select the conversation' },
  { keys: ['Esc'], key: 'wm.keys.close', fallback: 'Close / clear the selection' },
  { keys: ['Ctrl', 'Enter'], key: 'wm.keys.send', fallback: 'Send (in the composer)' },
  { keys: ['Ctrl', 'K'], key: 'wm.keys.palette', fallback: 'Command palette' },
  { keys: ['?'], key: 'wm.keys.help', fallback: 'Keyboard shortcuts' },
];
