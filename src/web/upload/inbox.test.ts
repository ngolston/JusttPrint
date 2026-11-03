import { describe, expect, it } from 'vitest';
import { runOnLoad, type OrganizeRun } from './inbox';

const run = (running: boolean) => ({ id: 1, running }) as OrganizeRun;

describe('Organize run when a page opens', () => {
  it('shows a run still going', () => {
    expect(runOnLoad(run(true))).toEqual(run(true));
  });
  it('does not show a finished run again (its result is in the notifications)', () => {
    expect(runOnLoad(run(false))).toBeNull();
  });
  it('shows nothing when there was no run', () => {
    expect(runOnLoad(null)).toBeNull();
  });
});
