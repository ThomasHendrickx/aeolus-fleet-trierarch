import { describe, expect, it } from 'vitest';

import { type CommitStatus, stagingWalkVerdict } from './staging-walk-gate.ts';

const SHA = '2008806c3eb14be4b6c3fae7fefdfdb9c4969453';
const OWNER = 'ThomasHendrickx';
const WALK_URL = 'https://claude.ai/artifact/walk';

function aStatus(status: Partial<CommitStatus> = {}): CommitStatus {
  return { context: 'staging-walk', state: 'success', target_url: WALK_URL, ...status };
}

function verdict(release: { statuses?: CommitStatus[]; overrideReason?: string; actor?: string } = {}) {
  return stagingWalkVerdict({ sha: SHA, owner: OWNER, actor: OWNER, overrideReason: '', statuses: [aStatus()], ...release });
}

describe('the staging walk gate', () => {
  it('lets a commit whose staging walk passed be released', () => {
    expect(verdict()).toEqual({ verdict: 'walked', url: WALK_URL });
  });

  it('refuses a commit the walker has not reported on', () => {
    expect(verdict({ statuses: [] })).toEqual({ verdict: 'refused', why: `No staging walk of ${SHA}: the walker has not reported on it` });
  });

  it('refuses a commit whose staging walk failed, linking the walk', () => {
    expect(verdict({ statuses: [aStatus({ state: 'failure' })] })).toEqual({
      verdict: 'refused',
      why: `The staging walk of ${SHA} did not pass (failure): ${WALK_URL}`,
    });
  });

  it('refuses a commit whose staging walk is still pending', () => {
    expect(verdict({ statuses: [aStatus({ state: 'pending' })] })).toEqual({
      verdict: 'refused',
      why: `The staging walk of ${SHA} did not pass (pending): ${WALK_URL}`,
    });
  });

  it('reads only the staging-walk status, not other checks on the commit', () => {
    expect(verdict({ statuses: [aStatus({ context: 'ci/other', state: 'success' })] })).toEqual({
      verdict: 'refused',
      why: `No staging walk of ${SHA}: the walker has not reported on it`,
    });
  });

  it('judges by the newest staging walk, so a failed walk after a pass refuses', () => {
    const statuses = [aStatus({ state: 'failure', target_url: 'https://claude.ai/artifact/second' }), aStatus()];
    expect(verdict({ statuses })).toEqual({
      verdict: 'refused',
      why: `The staging walk of ${SHA} did not pass (failure): https://claude.ai/artifact/second`,
    });
  });

  it('lets Thomas overrule a failed walk with a reason', () => {
    expect(verdict({ statuses: [aStatus({ state: 'failure' })], overrideReason: 'The walk failed on a staging fault' })).toEqual({
      verdict: 'overruled',
      reason: 'The walk failed on a staging fault',
    });
  });

  it('lets Thomas overrule a missing walk with a reason', () => {
    expect(verdict({ statuses: [], overrideReason: 'Hotfix for a production outage' })).toEqual({
      verdict: 'overruled',
      reason: 'Hotfix for a production outage',
    });
  });

  it('refuses an override from anyone but Thomas, the repository owner', () => {
    expect(verdict({ statuses: [aStatus({ state: 'failure' })], overrideReason: 'ship it', actor: 'orchestrator-bot' })).toEqual({
      verdict: 'refused',
      why: `Only ${OWNER} overrules the staging walk; orchestrator-bot dispatched this release`,
    });
  });

  it('takes a blank reason as no override', () => {
    expect(verdict({ statuses: [], overrideReason: '   ' })).toEqual({ verdict: 'refused', why: `No staging walk of ${SHA}: the walker has not reported on it` });
  });
});
