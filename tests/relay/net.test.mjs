import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, isLocalOrigin } from '../../relay/net.js';

test('private addresses', () => {
  for (const a of ['127.0.0.1', '::1', '::ffff:192.168.1.50', '10.0.0.5', '172.20.1.1', 'fd12::1', '::ffff:127.0.0.1', '100.64.1.2'])
    assert.equal(isPrivateAddress(a), true, a);
  for (const a of ['172.32.0.1', '100.128.0.1', '8.8.8.8', '::ffff:8.8.8.8', '2001:db8::1', '', undefined, '999.1.1.1', 'fd.example.com', 'localhost'])
    assert.equal(isPrivateAddress(a), false, String(a));
});

test('local origins', () => {
  assert.equal(isLocalOrigin('http://192.168.1.50:8790'), true);
  assert.equal(isLocalOrigin('http://localhost:5500'), true);
  assert.equal(isLocalOrigin('http://mybox.local'), true);
  assert.equal(isLocalOrigin('https://example.com'), false);
  assert.equal(isLocalOrigin('null'), false);
  assert.equal(isLocalOrigin(undefined), false);
});
