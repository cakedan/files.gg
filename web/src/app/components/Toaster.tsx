import { CheckCircle2, CircleAlert, X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';

import { ToastContext, type Notify, type ToastAction, type ToastTone } from './toastContext';

interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction | undefined;
}

const TIMEOUT_MS = 5000;

export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((toast) => toast.id !== id)), []);
  const notify = useCallback<Notify>(
    (message, tone = 'success', action) => {
      const id = next.current++;
      setToasts((list) => [...list.slice(-2), { id, message, tone, action }]);
      // A toast with a link stays twice as long, so there's time to reach it.
      window.setTimeout(() => dismiss(id), action ? TIMEOUT_MS * 2 : TIMEOUT_MS);
    },
    [dismiss],
  );
  const value = useMemo(() => notify, [notify]);

  const polite = toasts.filter((toast) => toast.tone !== 'error');
  const assertive = toasts.filter((toast) => toast.tone === 'error');

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[80] flex flex-col items-center gap-2 px-4 sm:bottom-6">
        <div role="status" aria-live="polite" className="flex flex-col items-center gap-2">
          {polite.map((toast) => (
            <ToastView key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>
        <div role="alert" aria-live="assertive" className="flex flex-col items-center gap-2">
          {assertive.map((toast) => (
            <ToastView key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const Icon = toast.tone === 'error' ? CircleAlert : CheckCircle2;
  return (
    <div className="pointer-events-auto flex max-w-md items-start gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm shadow-card">
      <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${toast.tone === 'error' ? 'text-danger' : 'text-gg'}`} />
      <span className="min-w-0 flex-1">{toast.message}</span>
      {toast.action && (
        <Link to={toast.action.to} onClick={() => onDismiss(toast.id)} className="shrink-0 font-medium text-gg hover:underline">
          {toast.action.label}
        </Link>
      )}
      <button type="button" onClick={() => onDismiss(toast.id)} aria-label="Dismiss" className="-m-0.5 rounded p-0.5 text-muted hover:text-text">
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}
