/*
 * Every pop-up window (a modal <dialog>) closes when you click outside it, on the dimmed page
 * around it, as Escape closes it: its cancel event runs first, so a message counts it as Cancel,
 * and a window that refuses Escape (busy, say) stays. Only a press and release both outside count,
 * so a drag that starts in a field and ends outside does not close it. A dialog with
 * data-no-outside-close keeps the old way.
 */

/** Whether (x, y) is outside the box. */
export function isOutside(box: { left: number; right: number; top: number; bottom: number }, x: number, y: number): boolean {
  return x < box.left || x > box.right || y < box.top || y > box.bottom;
}

function backdropOf(event: MouseEvent): HTMLDialogElement | null {
  const dialog = event.target;
  if (!(dialog instanceof HTMLDialogElement) || !dialog.open || dialog.hasAttribute('data-no-outside-close')) return null;
  // Only windows opened with showModal() have a backdrop (the Settings page's embedded forms do not).
  try {
    if (!dialog.matches(':modal')) return null;
  } catch {
    /* an older browser without :modal: every open dialog the click landed on outside is one */
  }
  return isOutside(dialog.getBoundingClientRect(), event.clientX, event.clientY) ? dialog : null;
}

/** Close a dialog as Escape does: cancel first (it may refuse), then close. */
export function closeAsEscape(dialog: HTMLDialogElement) {
  const request = (dialog as HTMLDialogElement & { requestClose?: () => void }).requestClose;
  if (typeof request === 'function') {
    request.call(dialog);
    return;
  }
  if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
}

let installed = false;

export function installOutsideClose(doc: Document = document) {
  if (installed) return;
  installed = true;
  let pressedOn: HTMLDialogElement | null = null;
  doc.addEventListener('pointerdown', (event) => (pressedOn = backdropOf(event)), true);
  doc.addEventListener(
    'click',
    (event) => {
      const dialog = backdropOf(event);
      const pressed = pressedOn;
      pressedOn = null;
      if (dialog && dialog === pressed) closeAsEscape(dialog);
    },
    true
  );
}
