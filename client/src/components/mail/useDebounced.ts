import { useEffect, useState } from 'react';

/** `value`, updated `delayMs` after it stops changing (search fields hitting the server). */
export function useDebounced<T>(value: T, delayMs = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return v;
}
