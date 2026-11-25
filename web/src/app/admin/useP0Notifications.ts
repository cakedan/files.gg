import { useCallback, useEffect, useRef, useState } from 'react';

import { getItem, setItem } from '../../lib/storage';

/** §11.3: the opt-in choice for P0 browser notifications. */
export const NOTIFY_KEY = 'filesgg.admin.notify';
/** The text names no content (§11.3). */
export const P0_NOTIFICATION_TEXT = 'New P0 case on files.gg';

const supported = () => typeof window !== 'undefined' && 'Notification' in window;

/**
 * Browser notifications for new P0 cases (milestone-4 §11.3, no Web Push): opt in with
 * a click (`Notification.requestPermission()`), remembered in `filesgg.admin.notify`.
 * While an admin page is open, a notification fires when `newest_p0_at` increases.
 */
export function useP0Notifications(newestP0At: number | null | undefined) {
  const [enabled, setEnabled] = useState(() => supported() && getItem(NOTIFY_KEY) === '1' && Notification.permission === 'granted');
  const [message, setMessage] = useState<string | null>(null);
  const seen = useRef<number | null>(null);

  useEffect(() => {
    if (newestP0At === undefined || newestP0At === null) return;
    const previous = seen.current;
    if (previous === null || newestP0At > previous) seen.current = newestP0At;
    // The first summary only sets the baseline.
    if (previous !== null && newestP0At > previous && enabled && supported() && Notification.permission === 'granted') {
      try {
        new Notification(P0_NOTIFICATION_TEXT, { tag: 'filesgg-p0' });
      } catch {
        // Some browsers only allow notifications from a service worker.
      }
    }
  }, [newestP0At, enabled]);

  const toggle = useCallback(async () => {
    if (enabled) {
      setItem(NOTIFY_KEY, '0');
      setEnabled(false);
      setMessage(null);
      return;
    }
    if (!supported()) {
      setMessage('This browser doesn’t support notifications.');
      return;
    }
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      setItem(NOTIFY_KEY, '1');
      setEnabled(true);
      setMessage(null);
    } else {
      setItem(NOTIFY_KEY, '0');
      setMessage('Notifications are blocked for files.gg in this browser’s settings.');
    }
  }, [enabled]);

  return { enabled, toggle, message, supported: supported() };
}
