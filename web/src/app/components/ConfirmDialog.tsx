import { useRef, type ReactNode } from 'react';

import { Button } from '../../components/Button';
import { Dialog } from './Dialog';

interface ConfirmDialogProps {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  pending?: boolean;
  error?: string | null;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/** A yes/no confirmation. Focus starts on Cancel, so Enter never deletes by accident. */
export function ConfirmDialog({ title, children, confirmLabel, pendingLabel, pending = false, error, danger = true, onConfirm, onClose }: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      title={title}
      onClose={onClose}
      initialFocus={cancelRef}
      size="sm"
      alert
      footer={
        <>
          <Button ref={cancelRef} onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} disabled={pending}>
            {pending ? (pendingLabel ?? confirmLabel) : confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm text-muted">
        {children}
        {error && (
          <p className="text-danger" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
