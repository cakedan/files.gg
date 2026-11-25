import { createContext, useContext } from 'react';

export type ToastTone = 'success' | 'error' | 'info';
/** A link in the toast, a dashboard path ("You were signed out." → Sign in). */
export interface ToastAction {
  label: string;
  to: string;
}
export type Notify = (message: string, tone?: ToastTone, action?: ToastAction) => void;

export const ToastContext = createContext<Notify>(() => undefined);

/** Short status messages, announced politely (errors assertively). */
export function useToast(): Notify {
  return useContext(ToastContext);
}
