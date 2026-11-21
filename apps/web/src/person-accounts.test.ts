import test from 'node:test';
import assert from 'node:assert/strict';
import { personAccounts } from './person-accounts.ts';
test('one human account list hides assignment ledger and combines donor aliases without losing raw account IDs', () => {
  const row = (id: string, source: string, account_id: string, display_name: string, external_id = id) => ({
    id,
    source,
    account_id,
    display_name,
    external_id,
  });
  const input = [
    row('t', 'twitch', 'owner', 'viewer4207'),
    row('t2', 'twitch', 'other-owner', 'viewer4207', 't'),
    row('y', 'youtube', 'channel', '@samplechannel6515'),
    row('da1', 'donationalerts', 'provider', 'Иван4ик'),
    row('da2', 'donationalerts', 'provider', 'Ivan4ik'),
    row('c1', 'donationalerts', 'correction:one', 'Иван4ик'),
    row('c2', 'donationalerts', 'correction:two', 'viewer4207'),
    row('m', 'donationalerts', 'manual:three', 'Иван4ик'),
    row('anon', 'donationalerts', 'provider', 'Аноним', 'anonymous:donor'),
  ];
  const result = personAccounts(input, 'Иван4ик');
  assert.equal(result.length, 3);
  assert.deepEqual(result[0]!.ids, ['t', 't2']);
  assert.equal(result[2]!.display_name, 'Иван4ик');
  assert.deepEqual(result[2]!.ids, ['da1', 'da2']);
  assert.deepEqual(result[2]!.aliases, ['Ivan4ik']);
  assert.equal(input.length, 9, 'presentation never deletes stored facts');
});
