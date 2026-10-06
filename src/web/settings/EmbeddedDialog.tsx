import { useLayoutEffect, useState } from 'react';
import { adopt } from '../shell/adopt';

type WithShowModal = HTMLDialogElement & { showModal: () => void };

/**
 * A settings dialog shown inside the Settings page (spec §47): while mounted, the <dialog> is
 * moved into this box and opened in place (non-modal) through its usual opener, so it loads its
 * saved values as always. When its own Save, Cancel or Close closes it, it opens again with the
 * saved values. On unmount it closes and goes back, and opens as a modal again elsewhere.
 */
export function EmbeddedDialog({ dialogId, opener }: { dialogId: string; opener: string }) {
  const [host, setHost] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const dialog = host ? document.getElementById(dialogId) as WithShowModal | null : null;
    if (!host || !dialog) return undefined;
    const restore = adopt(`#${CSS.escape(dialogId)}`, host);
    let alive = true;
    const open = () => {
      const fn = (window as unknown as Record<string, unknown>)[opener];
      if (typeof fn === 'function') fn();
    };
    // The opener calls showModal(); here the dialog opens in the page instead.
    dialog.showModal = () => { if (!dialog.open) dialog.show(); };
    dialog.classList.add('is-embedded');
    const onClose = () => { if (alive) setTimeout(() => { if (alive) open(); }, 0); };
    if (dialog.open) dialog.close();
    dialog.addEventListener('close', onClose);
    open();
    return () => {
      alive = false;
      dialog.removeEventListener('close', onClose);
      if (dialog.open) dialog.close();
      delete (dialog as Partial<WithShowModal>).showModal;
      dialog.classList.remove('is-embedded');
      restore?.();
    };
  }, [host, dialogId, opener]);

  return <div className="jp-settings-embed" ref={setHost} />;
}
