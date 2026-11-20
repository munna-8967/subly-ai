import { useCallback, useRef, useState } from 'react';

/**
 * Undo/redo for a value. `commit` records a new state; consecutive commits with the same
 * `group` key inside 800 ms (typing in one field) are merged into one undo step.
 */
export function useHistory<T>(initial: T) {
  const [present, setPresent] = useState<T>(initial);
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const lastGroup = useRef<{ key: string; at: number } | null>(null);
  const [, bump] = useState(0);

  const commit = useCallback((next: T, group?: string) => {
    const now = Date.now();
    const merge = group !== undefined && lastGroup.current?.key === group && now - lastGroup.current.at < 800;
    lastGroup.current = group === undefined ? null : { key: group, at: now };
    setPresent((current) => {
      if (!merge) {
        past.current.push(current);
        if (past.current.length > 100) past.current.shift();
      }
      return next;
    });
    future.current = [];
    bump((n) => n + 1);
  }, []);

  const undo = useCallback(() => {
    setPresent((current) => {
      const previous = past.current.pop();
      if (previous === undefined) return current;
      future.current.push(current);
      return previous;
    });
    lastGroup.current = null;
    bump((n) => n + 1);
  }, []);

  const redo = useCallback(() => {
    setPresent((current) => {
      const next = future.current.pop();
      if (next === undefined) return current;
      past.current.push(current);
      return next;
    });
    lastGroup.current = null;
    bump((n) => n + 1);
  }, []);

  /** Replace the value and forget all history (after loading from the server). */
  const reset = useCallback((value: T) => {
    past.current = [];
    future.current = [];
    lastGroup.current = null;
    setPresent(value);
    bump((n) => n + 1);
  }, []);

  return { value: present, commit, undo, redo, reset, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}
