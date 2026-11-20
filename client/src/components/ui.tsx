import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { ProjectStatus } from '../types';

export function Alert({ kind = 'info', title, children, onClose }: { kind?: 'info' | 'error' | 'success' | 'warning'; title?: string; children: ReactNode; onClose?: () => void }) {
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div>
        {title && <strong>{title} </strong>}
        {children}
      </div>
      {onClose && (
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Dismiss message">
          &times;
        </button>
      )}
    </div>
  );
}

const STATUS_LABEL: Record<ProjectStatus, string> = {
  empty: 'No video',
  draft: 'Draft',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Needs attention',
};

export function StatusChip({ status }: { status: ProjectStatus }) {
  return <span className={`chip chip-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function ProgressBar({ value, label }: { value: number | null; label: string }) {
  const pct = value === null ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className={`progress-bar${pct === undefined ? ' indeterminate' : ''}`} style={pct === undefined ? undefined : { width: `${pct}%` }} />
    </div>
  );
}

/** Modal dialog built on <dialog>: focus trap, Escape and backdrop come from the browser. */
export function Dialog({ open, title, children, onClose }: { open: boolean; title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} onCancel={onClose} aria-labelledby="dialog-title">
      {open && (
        <div className="dialog-body">
          <h2 id="dialog-title">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmDialog(props: { open: boolean; title: string; message: ReactNode; confirmLabel: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Dialog open={props.open} title={props.title} onClose={props.onCancel}>
      <div className="dialog-text">{props.message}</div>
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={props.onCancel} autoFocus>
          Cancel
        </button>
        <button type="button" className={`btn ${props.danger ? 'btn-danger' : 'btn-primary'}`} onClick={props.onConfirm} disabled={props.busy}>
          {props.busy ? 'Working…' : props.confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
