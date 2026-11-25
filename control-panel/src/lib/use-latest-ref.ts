import { useLayoutEffect, useRef } from 'react';

/**
 * A ref that always holds the latest committed `value`, for effects and async callbacks that must not re-run when it
 * changes (a translation function, a callback prop). It is updated in a layout effect, not during render (React's
 * rules: no ref access in render, YE-205), which still runs before every passive effect and event handler that reads it.
 */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}
