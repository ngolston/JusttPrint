import { describe, expect, it } from 'vitest';
import { SIGNIN_MESSAGE, tokenFromMessage } from './puterAuth';

describe('Puter sign-in message', () => {
  const own = 'http://nas.local:5000';

  it('takes the token from this server\'s sign-in page', () => {
    expect(tokenFromMessage({ type: SIGNIN_MESSAGE, token: ' abc ' }, own, own)).toBe('abc');
  });

  it('ignores other origins, other messages and empty tokens', () => {
    expect(tokenFromMessage({ type: SIGNIN_MESSAGE, token: 'abc' }, 'https://evil.example', own)).toBeNull();
    expect(tokenFromMessage({ type: 'something-else', token: 'abc' }, own, own)).toBeNull();
    expect(tokenFromMessage({ type: SIGNIN_MESSAGE, token: '' }, own, own)).toBeNull();
    expect(tokenFromMessage({ type: SIGNIN_MESSAGE, token: 42 }, own, own)).toBeNull();
    expect(tokenFromMessage('abc', own, own)).toBeNull();
  });
});
