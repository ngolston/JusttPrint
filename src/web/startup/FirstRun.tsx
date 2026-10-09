import { useEffect, useRef, useSyncExternalStore } from 'react';
import { settings } from '../api';

/**
 * The first-run dialogs: the terms (MIT license), which must be accepted before the app loads,
 * and the welcome that follows on the very first run. startup/start.ts asks for the answer
 * (checkTerms) as the page starts, possibly before React has drawn anything, so the state
 * lives here at module level and the dialogs show it once mounted.
 */

declare global {
  interface Window {
    /** Show the welcome dialog (first run). */
    showWelcome?: () => void;
    logOutOfServer?: () => Promise<void>;
    showGuide?: () => void;
  }
}

let state = { askingTerms: false, welcome: false };
const listeners = new Set<() => void>();
function set(patch: Partial<typeof state>) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

let termsAnswer: Promise<boolean> | null = null;
let answerTerms: ((accepted: boolean) => void) | null = null;

/** Resolves true once the terms are accepted (asking first if needed); false when declined. */
export function checkTerms(): Promise<boolean> {
  termsAnswer ??= (async () => {
    try {
      if (await settings.get<string | null>('tosAcceptedDate')) return true;
    } catch (error) {
      console.error('Error checking Terms of Service:', error);
      return false;
    }
    return new Promise<boolean>((resolve) => {
      answerTerms = resolve;
      set({ askingTerms: true });
    });
  })();
  return termsAnswer;
}

if (typeof window !== 'undefined') {
  window.showWelcome = () => set({ welcome: true });
}

/** Open or close a <dialog> with the state. */
function useModal(open: boolean) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return ref;
}

export function FirstRun() {
  const { askingTerms, welcome } = useSyncExternalStore(subscribe, () => state);
  const termsRef = useModal(askingTerms);
  const welcomeRef = useModal(welcome);

  const answer = async (accepted: boolean) => {
    if (accepted) await settings.save('tosAcceptedDate', new Date().toISOString());
    set({ askingTerms: false });
    answerTerms?.(accepted);
    answerTerms = null;
    // Declining logs this browser out; the server keeps running for everyone else.
    if (!accepted) window.logOutOfServer?.();
  };

  return (
    <>
      {/* The terms cannot be dismissed with Escape: they need an answer. */}
      <dialog id="terms-of-service-dialog" className="modal tos-dialog" ref={termsRef} onCancel={(e) => e.preventDefault()}>
        <div className="tos-dialog-content">
          <div className="tos-header">
            <img src="assets/logo.png" alt="JusttPrint Logo" className="tos-logo" />
            <h2>Terms of Service</h2>
          </div>
          <div className="tos-body">
            <div className="tos-scroll-content">
              <h3>MIT License</h3>
              <p className="tos-copyright">Copyright (c) 2025 JusttPrint</p>
              <p>
                Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the
                "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish,
                distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
                following conditions:
              </p>
              <p>The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.</p>
              <p className="tos-warning">
                THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
                MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
                CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE
                OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
              </p>
              <p>By using this software, you agree to abide by the terms of this license.</p>
            </div>
          </div>
          <div className="tos-footer">
            <button id="decline-terms" className="tos-button tos-button-decline" onClick={() => answer(false)}>
              I Decline
            </button>
            <button id="accept-terms" className="tos-button tos-button-accept" onClick={() => answer(true)}>
              I Accept
            </button>
          </div>
        </div>
      </dialog>
      <dialog id="welcome-message" className="welcome-dialog" ref={welcomeRef} onClose={() => set({ welcome: false })}>
        <div className="welcome-content">
          <h2>Welcome to JusttPrint!</h2>
          <button
            id="dismiss-welcome"
            onClick={() => {
              set({ welcome: false });
              setTimeout(() => window.showGuide?.(), 500);
            }}
          >
            Get Started!
          </button>
        </div>
      </dialog>
    </>
  );
}
