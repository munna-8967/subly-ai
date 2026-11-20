import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../../server/src/config.ts';
import { AuthService } from '../../server/src/services/auth.ts';
import { CreditsService } from '../../server/src/services/credits.ts';
import { Db } from '../../server/src/services/db.ts';
import { NotificationService } from '../../server/src/services/notifications.ts';
import { generationCost, startedMinutes } from '../../shared/credits.js';

function setup(env: NodeJS.ProcessEnv = {}) {
  const config = loadConfig({ FREE_MONTHLY_CREDITS: '10', LOW_CREDIT_THRESHOLD: '3', ...env }, { dataDir: '/tmp/unused-subly' });
  const db = new Db(':memory:');
  const notifications = new NotificationService(db, config);
  const credits = new CreditsService(db, config, notifications);
  const auth = new AuthService(db, config);
  return { config, db, notifications, credits, auth };
}

test('cost rules count started minutes', () => {
  const costs = { transcribePerMinute: 1, translateMinutesPerCredit: 2, renderMinutesPerCredit: 5 };
  assert.equal(startedMinutes(1), 1);
  assert.equal(startedMinutes(60), 1);
  assert.equal(startedMinutes(61), 2);
  assert.equal(generationCost(61, false, costs), 2);
  assert.equal(generationCost(61, true, costs), 3);
});

test('register, login, wrong password, duplicate e-mail, sessions', async () => {
  const { auth } = setup();
  const user = await auth.register('A@Example.com', 'password123', 'Asha');
  assert.equal(user.email, 'a@example.com');
  await assert.rejects(auth.register('a@example.com', 'password123', ''), { code: 'email_taken' });
  await assert.rejects(auth.register('bad', 'password123', ''), { code: 'invalid_email' });
  await assert.rejects(auth.register('b@example.com', 'short', ''), { code: 'weak_password' });
  await assert.rejects(auth.login('a@example.com', 'wrong-password'), { code: 'bad_credentials' });
  await assert.rejects(auth.login('nobody@example.com', 'password123'), { code: 'bad_credentials' });
  const again = await auth.login('a@example.com', 'password123');
  const { token } = auth.createSession(again.id, 'test');
  assert.equal(auth.userForToken(token)?.id, user.id);
  auth.destroySession(token);
  assert.equal(auth.userForToken(token), null);
});

test('free monthly credits are granted lazily and expire at month end', async () => {
  const { auth, credits } = setup();
  const u = await auth.register('a@example.com', 'password123', '');
  const jan = new Date('2027-01-10T00:00:00Z');
  assert.equal(credits.balance(u.id, jan).free, 10);
  credits.spend(u.id, 4, 'x', undefined, jan);
  assert.equal(credits.balance(u.id, jan).free, 6);
  const feb = new Date('2027-02-01T00:00:01Z');
  const b = credits.balance(u.id, feb);
  assert.equal(b.free, 10, 'fresh allowance, unused 6 expired (not added up)');
  const kinds = credits.ledger(u.id).map((e) => e.kind);
  assert.ok(kinds.includes('free_expire') && kinds.filter((k) => k === 'free_grant').length === 2);
});

test('spend uses free first, then paid; insufficient credits is refused and changes nothing', async () => {
  const { auth, credits } = setup();
  const u = await auth.register('a@example.com', 'password123', '');
  credits.grantPaid(u.id, 5, 'purchase', 'pack', 'ref-1');
  credits.spend(u.id, 12, 'job');
  const b = credits.balance(u.id);
  assert.deepEqual([b.free, b.paid], [0, 3]);
  await assert.rejects(async () => credits.spend(u.id, 4, 'too much'), { code: 'insufficient_credits' });
  assert.equal(credits.balance(u.id).total, 3);
});

test('refund returns the same buckets once and only once; grant with same ref is idempotent', async () => {
  const { auth, credits } = setup();
  const u = await auth.register('a@example.com', 'password123', '');
  assert.equal(credits.grantPaid(u.id, 5, 'purchase', 'pack', 'pay-1'), true);
  assert.equal(credits.grantPaid(u.id, 5, 'purchase', 'pack', 'pay-1'), false);
  const id = credits.spend(u.id, 12, 'job');
  assert.equal(credits.refund(id, 'failed'), true);
  assert.equal(credits.refund(id, 'failed'), false);
  const b = credits.balance(u.id);
  assert.deepEqual([b.free, b.paid], [10, 5]);
  const ledger = credits.ledger(u.id);
  const sum = ledger.reduce((a, e) => a + e.delta, 0);
  assert.equal(sum, b.total, 'ledger adds up to the balance');
});

test('low-credit notifications fire once per dip and re-arm after top-up', async () => {
  const { auth, credits, notifications } = setup();
  const u = await auth.register('a@example.com', 'password123', '');
  credits.spend(u.id, 5, 'a'); // 5 left, above threshold 3
  assert.equal(notifications.list(u.id).items.length, 0);
  credits.spend(u.id, 2, 'b'); // 3 left -> low
  credits.spend(u.id, 1, 'c'); // 2 left, no second warning
  assert.deepEqual(notifications.list(u.id).items.map((n) => n.kind), ['credits_low']);
  credits.spend(u.id, 2, 'd'); // 0 -> empty
  assert.deepEqual(notifications.list(u.id).items.map((n) => n.kind), ['credits_empty', 'credits_low']);
  credits.grantPaid(u.id, 50, 'purchase', 'pack', 'p1');
  credits.spend(u.id, 48, 'e'); // 2 left again -> low again
  assert.equal(notifications.list(u.id).items[0]?.kind, 'credits_low');
  assert.equal(notifications.list(u.id).unread, 3);
  notifications.markAllRead(u.id);
  assert.equal(notifications.list(u.id).unread, 0);
});
