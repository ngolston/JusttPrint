import { useEffect, useRef, useState } from 'react';
import { settings, users as usersApi, type UserAccount, type UserRole } from './api';
import { ModalDialog } from './components/ModalDialog';
import { timeAgo } from './home/format';
import { exposeGlobal, showMessage } from './page';
import { ROLE_DESCRIPTIONS, ROLE_LABELS, loadCurrentUser, useCurrentUser } from './session';

declare global {
  interface Window {
    openUsers?: () => void;
  }
}

const ROLES: UserRole[] = ['viewer', 'editor', 'admin'];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function RoleSelect({
  id,
  value,
  disabled,
  label,
  onChange
}: {
  id: string;
  value: UserRole;
  disabled?: boolean;
  label?: string;
  onChange: (role: UserRole) => void;
}) {
  return (
    <select id={id} value={value} disabled={disabled} aria-label={label} onChange={(event) => onChange(event.target.value as UserRole)}>
      {ROLES.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABELS[role]}
        </option>
      ))}
    </select>
  );
}

/** One account: its role, a new password, delete. */
function UserRow({
  user,
  isMe,
  minLength,
  onChanged,
  setStatus
}: {
  user: UserAccount;
  isMe: boolean;
  minLength: number;
  onChanged: () => void;
  setStatus: (text: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [settingPassword, setSettingPassword] = useState(false);

  async function changeRole(role: UserRole) {
    try {
      await usersApi.update(user.id, { role });
      setStatus(`${user.username} is now ${ROLE_LABELS[role] === 'Admin' ? 'an' : 'a'} ${ROLE_LABELS[role]}.`);
      if (isMe) await loadCurrentUser();
    } catch (error) {
      setStatus(errorText(error));
    }
    onChanged();
  }

  async function changeDelete(on: boolean) {
    try {
      await usersApi.update(user.id, { canDeleteFiles: on });
      setStatus(on ? `${user.username} can now delete files from disk.` : `${user.username} can now only remove models from the library.`);
      if (isMe) await loadCurrentUser();
    } catch (error) {
      setStatus(errorText(error));
    }
    onChanged();
  }

  async function savePassword() {
    if (password.length < minLength) {
      setStatus(`Passwords are at least ${minLength} characters.`);
      return;
    }
    try {
      await usersApi.update(user.id, { password });
      setPassword('');
      setSettingPassword(false);
      setStatus(`New password set for ${user.username}. They are logged out everywhere.`);
    } catch (error) {
      setStatus(errorText(error));
    }
  }

  async function resetTwoFactor() {
    const answer = await showMessage(
      'Turn off two-factor sign-in',
      `Turn off two-factor sign-in for ${user.username}? They are signed out, and sign in with their password alone (or set it up again, when the library requires it).`,
      ['Turn Off', 'Cancel']
    );
    if (answer !== 'Turn Off') return;
    try {
      await usersApi.resetTwoFactor(user.id);
      setStatus(`Two-factor sign-in is off for ${user.username}.`);
    } catch (error) {
      setStatus(errorText(error));
    }
    onChanged();
  }

  async function remove() {
    const answer = await showMessage('Delete User', `Delete ${user.username}? They are logged out and can no longer log in. Their library edits stay.`, [
      'Delete',
      'Cancel'
    ]);
    if (answer !== 'Delete') return;
    try {
      await usersApi.remove(user.id);
      setStatus(`${user.username} was deleted.`);
    } catch (error) {
      setStatus(errorText(error));
    }
    onChanged();
  }

  return (
    <li className="users-row" data-username={user.username}>
      <div className="users-row__main">
        <span className="users-row__name">
          {user.username}
          {isMe && <span className="users-row__tag">you</span>}
          {user.fromEnv && (
            <span className="users-row__tag" title="Its password is set by JUSTTPRINT_PASSWORD">
              JUSTTPRINT_PASSWORD
            </span>
          )}
          {user.twoFactor && (
            <span className="users-row__tag" title="Signs in with a code from an authenticator app">
              Two-factor
            </span>
          )}
        </span>
        <span className="users-row__meta">{user.lastLoginAt ? `Last login ${timeAgo(user.lastLoginAt)}` : 'Never logged in'}</span>
      </div>
      <RoleSelect id={`user-role-${user.id}`} label={`Role of ${user.username}`} value={user.role} disabled={user.fromEnv} onChange={changeRole} />
      {user.role === 'editor' && (
        <label
          className="users-row__delete"
          title="Delete from Disk in the model menu, and deleting duplicates. Without it they remove models from the library."
        >
          <input type="checkbox" id={`user-delete-${user.id}`} checked={!!user.canDeleteFiles} onChange={(event) => void changeDelete(event.target.checked)} />
          <span>Can delete files from disk</span>
        </label>
      )}
      <div className="users-row__actions">
        {!user.fromEnv && !settingPassword && (
          <button type="button" onClick={() => setSettingPassword(true)}>
            Set Password
          </button>
        )}
        {user.twoFactor && !isMe && (
          <button type="button" onClick={() => void resetTwoFactor()} title="When they lost their phone and their recovery codes">
            Turn Off Two-factor
          </button>
        )}
        {!user.fromEnv && !isMe && (
          <button type="button" className="danger-button" onClick={remove}>
            Delete
          </button>
        )}
      </div>
      {settingPassword && (
        <div className="users-row__password">
          <label htmlFor={`user-password-${user.id}`}>New password for {user.username}</label>
          <input
            type="password"
            id={`user-password-${user.id}`}
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <button type="button" onClick={savePassword}>
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setSettingPassword(false);
              setPassword('');
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </li>
  );
}

/**
 * Settings → Users (admins): the accounts that can log in and their roles. Viewers browse and
 * download, editors also change the library, admins also change settings and accounts.
 * Registers window.openUsers.
 */
export function UsersDialog() {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const me = useCurrentUser();
  const [list, setList] = useState<UserAccount[] | null>(null);
  const [minLength, setMinLength] = useState(8);
  const [status, setStatus] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<UserRole>('viewer');
  const [canDelete, setCanDelete] = useState(false);
  const load = useRef(0);
  const [guestAccess, setGuestAccess] = useState(false);
  const [require2fa, setRequire2fa] = useState(false);

  async function refresh() {
    const ticket = ++load.current;
    try {
      const result = await usersApi.list();
      if (ticket !== load.current) return;
      setList(result.users);
      setMinLength(result.minPasswordLength);
      setGuestAccess((await settings.get<string | null>('guestAccess').catch(() => null)) === 'true');
      setRequire2fa(!!result.requireTwoFactor);
    } catch (error) {
      if (ticket === load.current) setStatus(`Could not load the users: ${errorText(error)}`);
    }
  }

  useEffect(
    () =>
      exposeGlobal('openUsers', () => {
        setStatus('');
        if (!dialogRef.current?.open) dialogRef.current?.showModal();
        void refresh();
      }),
    []
  );

  async function addUser() {
    const name = username.trim();
    if (!name) {
      setStatus('Enter a user name.');
      return;
    }
    if (password.length < minLength) {
      setStatus(`Passwords are at least ${minLength} characters.`);
      return;
    }
    try {
      const created = await usersApi.create({ username: name, password, role, canDeleteFiles: role === 'editor' && canDelete });
      setUsername('');
      setPassword('');
      setRole('viewer');
      setCanDelete(false);
      setStatus(`Added ${created.username} (${ROLE_LABELS[created.role]}). Give them the user name and password.`);
      await refresh();
    } catch (error) {
      setStatus(errorText(error));
    }
  }

  return (
    <ModalDialog
      id="users-dialog"
      title="Users"
      dialogRef={dialogRef}
      footer={
        <button type="button" id="close-users" onClick={() => dialogRef.current?.close()}>
          Close
        </button>
      }
    >
      <ul className="users-roles setting-description">
        {ROLES.map((r) => (
          <li key={r}>
            <strong>{ROLE_LABELS[r]}</strong>: {ROLE_DESCRIPTIONS[r]}
          </li>
        ))}
      </ul>
      <ul className="users-list" id="users-list" aria-label="Users">
        {list === null ? (
          <li className="setting-description">Loading…</li>
        ) : (
          list.map((user) => (
            <UserRow key={user.id} user={user} isMe={!!me && me.id === user.id} minLength={minLength} onChanged={refresh} setStatus={setStatus} />
          ))
        )}
      </ul>
      <label className="users-guest">
        <input
          type="checkbox"
          id="users-guest-access"
          checked={guestAccess}
          onChange={async (event) => {
            const on = event.target.checked;
            setGuestAccess(on);
            try {
              await settings.save('guestAccess', on ? 'true' : 'false');
              setStatus(on ? 'Guests can now browse without logging in.' : 'Guest access is off: everyone logs in.');
            } catch (error) {
              setGuestAccess(!on);
              setStatus(`Could not save: ${errorText(error)}`);
            }
          }}
        />
        <span>
          <strong>Guest access</strong>: people who open JusttPrint without logging in can browse, preview and download, like a Viewer. Anyone who can reach
          this server gets in, so leave it off if it is reachable from the internet.
        </span>
      </label>
      <label className="users-guest">
        <input
          type="checkbox"
          id="users-require-two-factor"
          checked={require2fa}
          onChange={async (event) => {
            const on = event.target.checked;
            if (on) {
              const answer = await showMessage(
                'Require two-factor sign-in',
                'Everyone will sign in with a code from an authenticator app. Accounts without it are signed out now and set it up at their next sign-in. Your own account needs it on first (Sign-in & security).',
                ['Require It', 'Cancel']
              );
              if (answer !== 'Require It') return;
            }
            try {
              const result = await usersApi.setRequireTwoFactor(on);
              setRequire2fa(result.required);
              setStatus(
                result.required
                  ? `Two-factor sign-in is required.${result.signedOut.length ? ` Signed out to set it up: ${result.signedOut.join(', ')}.` : ''}`
                  : 'Two-factor sign-in is no longer required.'
              );
              void refresh();
            } catch (error) {
              setStatus(errorText(error));
            }
          }}
        />
        <span>
          <strong>Require two-factor sign-in</strong>: everyone signs in with a code from an authenticator app as well as their password. Each person sets it up
          under Sign-in &amp; security, or at their next sign-in.
        </span>
      </label>
      <p id="users-status" className="setting-description" role="status">
        {status}
      </p>
      <fieldset className="users-add">
        <legend>Add a user</legend>
        <div className="users-add__fields">
          <div className="form-group">
            <label htmlFor="users-new-name">User name</label>
            <input
              type="text"
              id="users-new-name"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="users-new-password">Password</label>
            <input type="password" id="users-new-password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          </div>
          <div className="form-group">
            <label htmlFor="users-new-role">Role</label>
            <RoleSelect id="users-new-role" value={role} onChange={setRole} />
          </div>
          {role === 'editor' && (
            <label className="users-row__delete">
              <input type="checkbox" id="users-new-delete" checked={canDelete} onChange={(event) => setCanDelete(event.target.checked)} />
              <span>Can delete files from disk</span>
            </label>
          )}
        </div>
        <div className="dialog-buttons mcp-inline-actions">
          <button type="button" id="users-add" onClick={addUser}>
            Add User
          </button>
        </div>
      </fieldset>
    </ModalDialog>
  );
}
