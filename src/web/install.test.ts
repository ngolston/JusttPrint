import { describe, expect, it } from 'vitest';
import { installWay, type InstallContext } from './install';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0';

const ctx = (over: Partial<InstallContext>): InstallContext => ({
  userAgent: ANDROID_CHROME,
  standalone: false,
  secure: false,
  canPrompt: false,
  touchPoints: 5,
  ...over
});

describe('installWay', () => {
  it('knows when it already runs as the app', () => {
    expect(installWay(ctx({ standalone: true, canPrompt: true }))).toBe('installed');
  });

  it('uses the browser offer when there is one', () => {
    expect(installWay(ctx({ canPrompt: true, secure: true }))).toBe('prompt');
  });

  it('shows Add to Home Screen on iPhone and iPad, also over http', () => {
    expect(installWay(ctx({ userAgent: IPHONE }))).toBe('ios');
    expect(installWay(ctx({ userAgent: IPAD, touchPoints: 5 }))).toBe('ios');
  });

  it('a Mac without touch is not an iPad', () => {
    expect(installWay(ctx({ userAgent: IPAD, touchPoints: 0 }))).toBe('unsupported');
  });

  it('Chrome on plain http needs HTTPS; on HTTPS without an offer, the browser menu', () => {
    expect(installWay(ctx({ secure: false }))).toBe('needs-https');
    expect(installWay(ctx({ secure: true }))).toBe('browser-menu');
  });

  it('Firefox cannot install apps', () => {
    expect(installWay(ctx({ userAgent: FIREFOX, secure: true }))).toBe('unsupported');
  });
});
