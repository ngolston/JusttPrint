import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cx } from './Button';

interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

/**
 * A native <dialog> kept in step with `open`: focus moves in and is trapped by the browser,
 * Escape and the close button call onClose, and focus returns to where it was.
 */
function useDialog(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    const onCancel = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    dialog.addEventListener('cancel', onCancel);
    return () => dialog.removeEventListener('cancel', onCancel);
  }, [onClose]);
  return ref;
}

function Header({ title, onClose }: { title: ReactNode; onClose: () => void }) {
  return (
    <header className="jp-overlay__header">
      <h2 className="jp-panel-title">{title}</h2>
      <button type="button" className="jp-icon-btn jp-icon-btn--sm" aria-label="Close" title="Close" onClick={onClose}>
        <X size={16} aria-hidden="true" />
      </button>
    </header>
  );
}

/** A centred dialog for focused tasks (spec §38 Modal). */
export function Modal({ open, onClose, title, children, footer, className }: OverlayProps) {
  const ref = useDialog(open, onClose);
  return (
    <dialog ref={ref} className={cx('jp jp-modal', className)}>
      <Header title={title} onClose={onClose} />
      <div className="jp-overlay__body">{children}</div>
      {footer && <footer className="jp-overlay__footer">{footer}</footer>}
    </dialog>
  );
}

/** A panel sliding in from the right: the details panel below large desktop widths (spec §36). */
export function Drawer({ open, onClose, title, children, footer, className }: OverlayProps) {
  const ref = useDialog(open, onClose);
  return (
    <dialog ref={ref} className={cx('jp jp-drawer', className)}>
      <Header title={title} onClose={onClose} />
      <div className="jp-overlay__body">{children}</div>
      {footer && <footer className="jp-overlay__footer">{footer}</footer>}
    </dialog>
  );
}
