import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { LogIn } from 'lucide-react';
import { callAction } from '../api';
import { Button } from '../components/Button';
import { Modal } from '../components/Overlay';
import { exposeGlobal } from '../page';

declare global {
  interface Window {
    /** Ask for the MakerWorld sign-in. Resolves true once signed in, false when cancelled. */
    signInMakerWorld?: (reason?: string) => Promise<boolean>;
  }
}

interface Step {
  done: boolean;
  next?: 'code' | 'tfa';
  tfaKey?: string;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * MakerWorld sign-in (before the first download, or Settings → MakerWorld): the Bambu Lab
 * account's email and password, then the code Bambu Lab emails, or the authenticator code.
 * The JusttPrint backend keeps the sign-in for the whole server; the password is not kept.
 */
export function MakerWorldSignInDialog() {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'password' | 'code' | 'tfa'>('password');
  const [tfaKey, setTfaKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  useEffect(
    () =>
      exposeGlobal(
        'signInMakerWorld',
        (why?: string) =>
          new Promise<boolean>((resolve) => {
            resolver.current?.(false);
            resolver.current = resolve;
            setReason(why || '');
            setPassword('');
            setCode('');
            setStep('password');
            setError('');
            setOpen(true);
          })
      ),
    []
  );

  function finish(ok: boolean) {
    setOpen(false);
    setPassword('');
    resolver.current?.(ok);
    resolver.current = null;
  }

  async function submit() {
    setBusy(true);
    setError('');
    try {
      const input = step === 'password' ? { account: email, password } : step === 'code' ? { account: email, code } : { account: email, tfaKey, tfaCode: code };
      const result = await callAction<Step>('makerworld-sign-in', input);
      if (result.done) {
        finish(true);
      } else if (result.next) {
        setStep(result.next);
        setTfaKey(result.tfaKey || '');
        setCode('');
      }
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  }

  const ready = step === 'password' ? !!email.trim() && !!password : !!code.trim();
  const onEnter = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && ready && !busy) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => finish(false)}
      title="Sign In to MakerWorld"
      className="jp-upload jp-mw-signin"
      footer={
        <>
          <Button onClick={() => finish(false)}>Cancel</Button>
          <Button variant="primary" icon={LogIn} id="jp-mw-signin-submit" disabled={!ready || busy} onClick={submit}>
            {busy ? 'Signing In…' : step === 'password' ? 'Sign In' : 'Verify'}
          </Button>
        </>
      }
    >
      <p className="jp-mw-signin__intro">
        {reason ? `${reason} ` : ''}MakerWorld only gives files to signed-in accounts. Sign in with your Bambu Lab account (the one you use on MakerWorld).
        JusttPrint keeps the sign-in on its backend for everyone who downloads; your password is not kept.
      </p>
      {step === 'password' ? (
        <>
          <label className="jp-label" htmlFor="jp-mw-email">
            Email
          </label>
          <input
            id="jp-mw-email"
            className="jp-input jp-mw-signin__field"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            onKeyDown={onEnter}
          />
          <label className="jp-label" htmlFor="jp-mw-password">
            Password
          </label>
          <input
            id="jp-mw-password"
            className="jp-input jp-mw-signin__field"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            onKeyDown={onEnter}
          />
        </>
      ) : (
        <>
          <p className="jp-meta">{step === 'code' ? `Bambu Lab emailed a code to ${email}.` : 'Enter the code from your authenticator app.'}</p>
          <label className="jp-label" htmlFor="jp-mw-code">
            {step === 'code' ? 'Code from the email' : 'Authenticator code'}
          </label>
          <input
            id="jp-mw-code"
            className="jp-input jp-mw-signin__field"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={onEnter}
          />
        </>
      )}
      <p className="jp-upload__summary jp-mw-signin__error" role="alert" id="jp-mw-signin-error">
        {error}
      </p>
    </Modal>
  );
}
