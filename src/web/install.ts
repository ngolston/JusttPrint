/**
 * Installing JusttPrint as an app (home screen or desktop): which way this browser offers, so the
 * Install App dialog (InstallAppDialog.tsx) shows the right steps. Pure: tested in install.test.ts.
 */

export type InstallWay =
  /** Already running as the installed app. */
  | 'installed'
  /** The browser can install it now (Chrome, Edge, Samsung Internet): one button. */
  | 'prompt'
  /** iPhone or iPad: Share → Add to Home Screen (works over plain http too). */
  | 'ios'
  /** Android or desktop Chrome/Edge on plain http: installing needs HTTPS; a shortcut works. */
  | 'needs-https'
  /** Chrome/Edge on HTTPS without an offer yet (or already installed): the browser's menu. */
  | 'browser-menu'
  /** Firefox and others: no app install, a bookmark or shortcut instead. */
  | 'unsupported';

export interface InstallContext {
  userAgent: string;
  /** The page runs as an installed app (display-mode standalone, or iOS navigator.standalone). */
  standalone: boolean;
  /** https, or localhost. */
  secure: boolean;
  /** The browser fired beforeinstallprompt. */
  canPrompt: boolean;
  /** iPadOS reports a Mac user agent; touch tells them apart. */
  touchPoints: number;
}

export function installWay(ctx: InstallContext): InstallWay {
  if (ctx.standalone) return 'installed';
  if (ctx.canPrompt) return 'prompt';
  const ua = ctx.userAgent;
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && ctx.touchPoints > 1);
  if (ios) return 'ios';
  const chromium = /Chrome|Chromium|CriOS|Edg\/|SamsungBrowser/i.test(ua) && !/Firefox|FxiOS/i.test(ua);
  if (!chromium) return 'unsupported';
  return ctx.secure ? 'browser-menu' : 'needs-https';
}

/** The browser's install offer, kept for the Install button (Chrome fires it once per page). */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let offer: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

export const hasInstallOffer = () => !!offer;

export function onInstallOfferChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Show the browser's install question; resolves true when the app was installed. */
export async function promptInstall(): Promise<boolean> {
  if (!offer) return false;
  const event = offer;
  offer = null;
  listeners.forEach((fn) => fn());
  await event.prompt();
  return (await event.userChoice).outcome === 'accepted';
}

export function currentInstallContext(): InstallContext {
  return {
    userAgent: navigator.userAgent,
    standalone: window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true,
    secure: window.isSecureContext,
    canPrompt: !!offer,
    touchPoints: navigator.maxTouchPoints || 0
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    offer = event as InstallPromptEvent;
    listeners.forEach((fn) => fn());
  });
  window.addEventListener('appinstalled', () => {
    offer = null;
    listeners.forEach((fn) => fn());
  });
}
