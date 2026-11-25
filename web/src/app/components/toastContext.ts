import { createContext, useContext } from 'react';

export type ToastTone = 'success' | 'error' | 'info';
export type Notify = (message: string, tone?: ToastTone) => void;

export const ToastContext = createContext<Notify>(() => undefined);

/** Short status messages, announced politely (errors assertively). */
export function useToast(): Notify {
  return useContext(ToastContext);
}
