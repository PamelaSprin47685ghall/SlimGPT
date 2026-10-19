import assert from 'node:assert/strict';
import test from 'node:test';
import { decideTakeover } from '../../src/page/takeover.js';

test('takeover: show only with a usable composer, suspend for official blockers, respect the user', () => {
  const base = { visible: false, userHidden: false, hasComposer: true, blocked: false };
  assert.equal(decideTakeover(base), 'show');
  assert.equal(decideTakeover({ ...base, hasComposer: false }), null, 'login/challenge pages stay official');
  assert.equal(decideTakeover({ ...base, blocked: true }), null);
  assert.equal(decideTakeover({ ...base, userHidden: true }), null, '显示官方界面 sticks until restore');
  assert.equal(decideTakeover({ ...base, visible: true, blocked: true }), 'suspend', 'consent/modal dialogs fail open');
  assert.equal(decideTakeover({ ...base, visible: true }), null);
});
