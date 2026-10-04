import { useState, type ReactNode, type RefObject } from 'react';

interface ModalDialogProps {
  id: string;
  title: string;
  dialogRef: RefObject<HTMLDialogElement | null>;
  children: ReactNode;
  /** Buttons in the footer. Defaults to a Close button. */
  footer?: ReactNode;
  /** Show the Full Screen toggle in the header. */
  fullscreenToggle?: boolean;
  onClose?: () => void;
}

/**
 * A page dialog (<dialog class="modal">) with the app's header and footer layout.
 * Open it with dialogRef.current.showModal(). Enter in a field never submits or closes it.
 */
export function ModalDialog({ id, title, dialogRef, children, footer, fullscreenToggle, onClose }: ModalDialogProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const toggleLabel = fullscreen ? 'Exit Full Screen' : 'Full Screen';

  return (
    <dialog
      id={id}
      className={fullscreen ? 'modal modal-fullscreen' : 'modal'}
      ref={dialogRef}
      onClose={() => {
        setFullscreen(false);
        onClose?.();
      }}
    >
      <form method="dialog" onSubmit={(event) => event.preventDefault()}>
        <div className="modal-header-row">
          <h3>{title}</h3>
          {fullscreenToggle && (
            <button type="button" id={`${id}-fullscreen-toggle`} className="icon-button modal-fullscreen-icon-btn" title={toggleLabel}
              aria-label={toggleLabel} aria-pressed={fullscreen} onClick={() => setFullscreen(!fullscreen)}>
              <svg className="fullscreen-icon-expand" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3" />
              </svg>
              <svg className="fullscreen-icon-shrink" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24"
                fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3" />
              </svg>
            </button>
          )}
        </div>
        {children}
        <div className="dialog-buttons">
          {footer ?? <button type="button" onClick={() => dialogRef.current?.close()}>Close</button>}
        </div>
      </form>
    </dialog>
  );
}
