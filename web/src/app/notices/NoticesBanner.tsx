import { Bell, ShieldX } from 'lucide-react';
import { Link } from 'react-router';

/** On every dashboard page while notices are unacknowledged (milestone-4 §11.2). */
export function NoticesBanner({ count }: { count: number }) {
  return (
    <div role="status" className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
      <Bell aria-hidden className="size-4 shrink-0 text-warn" />
      <span className="min-w-0 flex-1">
        You have {count} {count === 1 ? 'notice' : 'notices'} about your files or account.
      </span>
      <Link to="/notices" className="font-medium text-gg hover:underline">
        View notices
      </Link>
    </div>
  );
}

/** A suspended account sees Notices and part of Settings (milestone-4 §8.4, milestone-6 §11.1). */
export function SuspendedBanner() {
  return (
    <div role="alert" className="mb-6 flex items-start gap-3 rounded-lg border border-danger/50 bg-danger/10 px-4 py-3 text-sm">
      <ShieldX aria-hidden className="mt-0.5 size-5 shrink-0 text-danger" />
      <div className="flex flex-col gap-1">
        <p className="font-semibold">Your account has been suspended</p>
        <p className="text-muted">
          You can still read your notices and appeal when it’s allowed, change your password, sign out your sessions and download your data. Everything
          else is unavailable.
        </p>
      </div>
    </div>
  );
}
