import { useEffect, useRef, useState } from 'react';
import { onServerEvent } from '../page';

interface Progress {
  title: string;
  message: string;
  current: number;
  total: number;
}

/** Progress of a long server task (backup, restore, organize): show-, update- and close-progress-dialog. */
export function ServerProgressDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [progress, setProgress] = useState<Progress | null>(null);

  useEffect(() => {
    const offs = [
      onServerEvent('show-progress-dialog', (data: { title?: string; message?: string; total?: number }) => {
        setProgress({ title: data?.title || 'Processing...', message: data?.message || 'Please wait...', current: 0, total: Number(data?.total) || 0 });
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
      }),
      onServerEvent('update-progress', (data: { current?: number; total?: number; message?: string }) => {
        setProgress((p) => p && { ...p, current: Number(data?.current) || 0, total: Number(data?.total) || p.total, message: data?.message || p.message });
      }),
      onServerEvent('close-progress-dialog', () => {
        if (dialogRef.current?.open) dialogRef.current.close();
        setProgress(null);
      })
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const percent = progress && progress.total > 0 ? Math.min(100, (progress.current / progress.total) * 100) : 0;
  return (
    <dialog id="progress-dialog" className="modal" ref={dialogRef} onCancel={(e) => e.preventDefault()}>
      <div className="progress-container">
        <h3 id="progress-title">{progress?.title || 'Processing...'}</h3>
        <p id="progress-message">{progress?.message || 'Please wait...'}</p>
        <div className="progress-bar-container">
          <div id="progress-bar" className="progress-bar" style={{ width: `${percent}%` }} />
        </div>
        <p id="progress-status">{progress ? `${progress.current} / ${progress.total}` : '0 / 0'}</p>
      </div>
    </dialog>
  );
}
