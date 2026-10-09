import { useEffect, useState } from 'react';
import { ExternalLink, KeyRound, LogIn } from 'lucide-react';
import { callAction } from '../api';
import { Button } from '../components/Button';
import { accountStatus } from '../makerworld/makerworld';
import { useCurrentUser } from '../session';
import { navigate } from '../shell/routes';

/** A link to another site, opened in a new tab. */
function Site({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="jp-site-setup__link">
      {children}<ExternalLink size={12} aria-hidden="true" />
    </a>
  );
}

/** What to do once for MakerWorld downloads. */
export function MakerWorldSteps() {
  return (
    <ol className="jp-site-setup__steps">
      <li>
        You need a Bambu Lab account: it is the account you use on MakerWorld. No account yet? Sign up free at{' '}
        <Site href="https://makerworld.com/en">makerworld.com</Site> (Sign In, then Sign Up).
      </li>
      <li>In JusttPrint, open <strong>Settings → Integrations → MakerWorld</strong> and click <strong>Sign In…</strong></li>
      <li>Enter the email and password of that account.</li>
      <li>If Bambu Lab emails you a code, enter it. That is all: JusttPrint keeps the sign-in for everyone and does not keep your password.</li>
    </ol>
  );
}

/** What to do once for Thingiverse downloads. */
export function ThingiverseSteps() {
  return (
    <ol className="jp-site-setup__steps">
      <li>
        Sign in to Thingiverse, or make a free account, at <Site href="https://www.thingiverse.com">thingiverse.com</Site>.
      </li>
      <li>
        Create an app at <Site href="https://www.thingiverse.com/apps/create">thingiverse.com/apps/create</Site> (more about it on{' '}
        <Site href="https://www.thingiverse.com/developers">thingiverse.com/developers</Site>). Any name works, for example <em>JusttPrint</em>;
        a <strong>Desktop app</strong> is enough.
      </li>
      <li>Open the app and copy its <strong>App Token</strong>.</li>
      <li>In JusttPrint, open <strong>Settings → Integrations → Thingiverse</strong>, paste the token and click <strong>Save Token</strong>.</li>
    </ol>
  );
}

/** Open one settings form (Settings → Integrations), scrolled to and shown for a moment. */
export function openSetting(id: 'makerworld' | 'thingiverse', before?: () => void) {
  before?.();
  navigate('settings', id);
}

/**
 * Add Links: when the pasted links include MakerWorld or Thingiverse and that site is not set up
 * yet, say that downloading needs a sign-in, what to do, and a button to the place in Settings.
 * Thingiverse's token is for admins to set: others are told to ask one.
 */
export function SiteSetupNotice({ sites, onLeave }: { sites: string[]; onLeave: () => void }) {
  const user = useCurrentUser();
  const isAdmin = user?.role === 'admin';
  const [makerWorldReady, setMakerWorldReady] = useState<boolean | null>(null);
  const [thingiverseReady, setThingiverseReady] = useState<boolean | null>(null);
  const wantsMakerWorld = sites.includes('makerworld');
  const wantsThingiverse = sites.includes('thingiverse');

  useEffect(() => {
    if (wantsMakerWorld) accountStatus().then((s) => setMakerWorldReady(s.signedIn), () => setMakerWorldReady(null));
    if (wantsThingiverse) callAction<{ hasToken: boolean }>('thingiverse-token-status').then((s) => setThingiverseReady(s.hasToken), () => setThingiverseReady(null));
  }, [wantsMakerWorld, wantsThingiverse]);

  const needMakerWorld = wantsMakerWorld && makerWorldReady === false;
  const needThingiverse = wantsThingiverse && thingiverseReady === false;
  if (!needMakerWorld && !needThingiverse) return null;
  const which = needMakerWorld && needThingiverse ? 'MakerWorld and Thingiverse' : needMakerWorld ? 'MakerWorld' : 'Thingiverse';

  return (
    <div className="jp-site-setup" role="note" id="jp-site-setup">
      <p className="jp-site-setup__title">To download models from {which}, you need to sign in{needMakerWorld && needThingiverse ? ' to each' : ''} first.</p>
      <p className="jp-meta">
        Until then, those links are added as online models (name, designer, license, picture and link), and you can download the files later
        by adding the same links again.
      </p>
      {needMakerWorld && (
        <section className="jp-site-setup__site" aria-labelledby="jp-site-setup-makerworld">
          <h4 id="jp-site-setup-makerworld">MakerWorld</h4>
          <MakerWorldSteps />
          {isAdmin && <Button size="sm" icon={LogIn} id="jp-site-setup-open-makerworld" onClick={() => openSetting('makerworld', onLeave)}>Open MakerWorld Settings</Button>}
          <span className="jp-meta">{isAdmin ? ' or ' : ''}{isAdmin ? 'sign in' : 'Sign in'} when JusttPrint asks, after you click Add.</span>
        </section>
      )}
      {needThingiverse && (
        <section className="jp-site-setup__site" aria-labelledby="jp-site-setup-thingiverse">
          <h4 id="jp-site-setup-thingiverse">Thingiverse</h4>
          <ThingiverseSteps />
          {isAdmin
            ? <Button size="sm" icon={KeyRound} id="jp-site-setup-open-thingiverse" onClick={() => openSetting('thingiverse', onLeave)}>Open Thingiverse Settings</Button>
            : <p className="jp-meta">Only an admin can add the token: ask yours to do step 4 (or all of them).</p>}
        </section>
      )}
    </div>
  );
}
