import { useEffect, useRef, useState } from 'react';
import { shareLinks, type ShareLink } from '../api';
import { ModalDialog } from '../components/ModalDialog';
import { timeAgo } from '../home/format';
import { copyText, exposeGlobal, showMessage } from '../page';
import { expiryLabel } from './ShareDialog';

declare global {
  interface Window {
    openShareLinks?: () => void;
  }
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Settings → Sharing: every share link on this server, what it shares, who made it, how often it
 * was opened, and Turn Off. Registers window.openShareLinks.
 */
export function ShareLinksDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [status, setStatus] = useState('');

  async function load() {
    try {
      setLinks(await shareLinks.list());
    } catch (error) {
      setStatus(errorText(error));
    }
  }

  useEffect(() => exposeGlobal('openShareLinks', () => {
    setStatus('');
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    void load();
  }), []);

  async function revoke(link: ShareLink) {
    const answer = await showMessage('Turn Off Link', `Turn off this link to ${link.targetName || 'a removed item'}? Anyone who has it can no longer open it.`, ['Turn Off', 'Cancel']);
    if (answer !== 'Turn Off') return;
    try {
      await shareLinks.revoke(link.token);
      setStatus('The link is off.');
      await load();
    } catch (error) {
      setStatus(errorText(error));
    }
  }

  async function revokeExpired() {
    const expired = (links || []).filter((link) => link.expired || !link.targetName);
    for (const link of expired) await shareLinks.revoke(link.token).catch(() => {});
    setStatus(`Removed ${expired.length} expired or broken ${expired.length === 1 ? 'link' : 'links'}.`);
    await load();
  }

  const stale = (links || []).filter((link) => link.expired || !link.targetName).length;
  return (
    <ModalDialog id="share-links-dialog" title="Share Links" dialogRef={dialogRef}
      footer={<button type="button" id="close-share-links" onClick={() => dialogRef.current?.close()}>Close</button>}>
      <p className="setting-description">
        Links open a read-only page without logging in. Make one from a model&apos;s menu (Share…) or a collection&apos;s Share button.
      </p>
      {links === null ? <p className="setting-description">Loading…</p> : links.length === 0 ? (
        <p className="setting-description" id="share-links-empty">No share links.</p>
      ) : (
        <ul className="jp-share__list jp-share__list--all" id="share-links-list">
          {links.map((link) => {
            const url = shareLinks.url(link.token);
            return (
              <li key={link.token} className={link.expired || !link.targetName ? 'is-expired' : undefined}>
                <span className="jp-share__list-text">
                  <span className="jp-share__list-name">
                    {link.kind === 'collection' ? 'Collection' : 'Model'}: {link.targetName
                      ? (link.kind === 'collection'
                        ? <a href={`#/collections/${link.targetId}`} onClick={() => dialogRef.current?.close()}>{link.targetName}</a>
                        : link.targetName)
                      : <em>no longer in the library</em>}
                  </span>
                  <span className="jp-meta">
                    {link.allowDownload ? 'Downloads' : 'View only'} · {expiryLabel(link)} · {link.views} {link.views === 1 ? 'view' : 'views'}
                    {link.lastViewedAt ? ` (last ${timeAgo(link.lastViewedAt)})` : ''}{link.createdBy ? ` · by ${link.createdBy}` : ''} · {timeAgo(link.createdAt)}
                  </span>
                </span>
                {!link.expired && link.targetName && (
                  <button type="button" onClick={async () => setStatus(await copyText(url) ? 'Link copied.' : url)}>Copy</button>
                )}
                <button type="button" className="danger-button" onClick={() => revoke(link)}>Turn Off</button>
              </li>
            );
          })}
        </ul>
      )}
      {stale > 0 && (
        <div className="dialog-buttons mcp-inline-actions">
          <button type="button" id="share-links-clean" onClick={revokeExpired}>Remove {stale} Expired or Broken</button>
        </div>
      )}
      <p className="setting-description" role="status" id="share-links-status">{status}</p>
    </ModalDialog>
  );
}
