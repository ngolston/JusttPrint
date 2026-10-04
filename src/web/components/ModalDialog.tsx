import { useState, type ReactNode, type RefObject } from 'react';

interface ModalDialogProps {
  id: string;
  title: ReactNode;
  dialogRef: RefObject<HTMLDialogElement | null>;
  children: ReactNode;
  /** Buttons in the footer. Defaults to a Close button. */
  footer?: ReactNode;
  /** Show the Full Screen toggle in the header. */
  fullscreenToggle?: boolean;
  /** Extra header buttons, shown before the Full Screen toggle in a wrapper with this class. */
  headerActions?: ReactNode;
  headerActionsClassName?: string;
  /** Text under the title. */
  description?: ReactNode;
  /** Class names for the header, when a dialog has its own header styles. */
  headerClassName?: string;
  headerRowClassName?: string;
  footerClassName?: string;
  /**
   * No <form method="dialog"> around the content: header, content and footer are the dialog's
   * direct children (for dialogs whose CSS lays them out, or that hold forms of their own).
   */
  plain?: boolean;
  /** Extra classes on the <dialog>, for dialogs styled by class. */
  className?: string;
  onClose?: () => void;
}

/**
 * A page dialog (<dialog class="modal">) with the app's header and footer layout.
 * Open it with dialogRef.current.showModal(). Enter in a field never submits or closes it.
 */
export function ModalDialog({
  id, title, dialogRef, children, footer, fullscreenToggle, headerActions, headerActionsClassName, description,
  headerClassName, headerRowClassName = 'modal-header-row', footerClassName = 'dialog-buttons', plain, className, onClose
}: ModalDialogProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const toggleLabel = fullscreen ? 'Exit Full Screen' : 'Full Screen';

  const toggle = fullscreenToggle && (
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
  );

  const headerRow = (
    <div className={headerRowClassName}>
      <h3>{title}</h3>
      {headerActions ? <div className={headerActionsClassName}>{headerActions}{toggle}</div> : toggle}
    </div>
  );

  const content = (
    <>
      {headerClassName ? (
        <div className={headerClassName}>{headerRow}{description}</div>
      ) : (
        <>{headerRow}{description}</>
      )}
      {children}
      <div className={footerClassName}>
        {footer ?? <button type="button" onClick={() => dialogRef.current?.close()}>Close</button>}
      </div>
    </>
  );

  return (
    <dialog
      id={id}
      className={['modal', className, fullscreen ? 'modal-fullscreen' : ''].filter(Boolean).join(' ')}
      ref={dialogRef}
      onClose={() => {
        setFullscreen(false);
        onClose?.();
      }}
    >
      {plain ? content : (
        <form method="dialog" onSubmit={(event) => event.preventDefault()}>{content}</form>
      )}
    </dialog>
  );
}
