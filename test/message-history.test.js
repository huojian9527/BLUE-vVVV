import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Store } from '../store.js';

const jid = '123456789@s.whatsapp.net';
test('history pages retain tied timestamps, old conversations, unread counts and account isolation', async () => {
  const dir = await mkdtemp('/tmp/blue-history-page-'); const store = new Store(dir);
  try {
    await store.bootstrap('history-admin', 'password-123');
    const owner = store.byName('history-admin');
    const a = store.createAccount(owner.id, 'A'), b = store.createAccount(owner.id, 'B');
    const oldJid = '987654321@s.whatsapp.net';
    store.remember(a.id, { id: 'old-chat', jid: oldJid, text: 'Old conversation', time: 1 });
    const entries = Array.from({ length: 650 }, (_, i) => ({ id: `m-${i}`, jid, text: `Message ${i}`, time: 1000 + Math.floor(i / 3) }));
    for (const message of entries) store.remember(a.id, message);
    store.remember(b.id, { id: 'foreign', jid, text: 'Never expose', time: 2000 });
    const snapshot = store.snapshotMessages(a.id);
    assert.equal(snapshot.length, 201);
    assert.equal(snapshot[0].id, 'old-chat', 'inactive conversations remain visible');
    assert.equal(snapshot.at(-1).unreadCount, 650, 'unread count includes messages outside the window');
    store.updateContact(a.id, jid, { readAt: 9999 });
    assert.equal(store.snapshotMessages(a.id).at(-1).unreadCount, 0);
    const collected = []; let before = null;
    do {
      const page = store.messagePage(a.id, jid, before);
      assert.ok(page.messages.length <= 100);
      collected.unshift(...page.messages); before = page.before;
    } while (before);
    assert.deepEqual(collected, entries);
    assert.equal(store.message(a.id, entries[0].id).text, 'Message 0');
    assert.equal(store.message(b.id, entries[0].id), undefined);
    assert.equal(store.hasConversation(a.id, oldJid), true);
    assert.equal(store.hasConversation(b.id, oldJid), false);
    assert.throws(() => store.messagePage(b.id, jid, entries[0].id), /游标/);
    assert.throws(() => store.messagePage(a.id, oldJid, entries[0].id), /游标/);
    assert.throws(() => store.messagePage(a.id, jid, null, 201), /每页/);
    // Old automation menus and direct actions still work outside the live window.
    const menu = { nodeId: 'start', options: [{ label: 'Next', next: 'next' }] };
    store.remember(a.id, { id: 'old-menu', jid, text: 'Menu', outgoing: true, automatic: true, buttons: [{ label: 'Next' }], flow: menu, time: 2 });
    assert.deepEqual(store.flowMenu(a.id, jid, 'start', 'old-menu', []), menu);
    assert.deepEqual(store.flowMenu(a.id, jid, 'start', null, []), menu);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('large on-disk histories can serve snapshots and pages under a 64 MiB JS heap', { timeout: 60000 }, async () => {
  const dir = await mkdtemp('/tmp/blue-history-memory-'); const store = new Store(dir);
  try {
    await store.bootstrap('memory-admin', 'password-123');
    const account = store.createAccount(store.byName('memory-admin').id, 'Large history');
    const text = 'x'.repeat(24 * 1024);
    store.db.exec('BEGIN');
    for (let i = 0; i < 4000; i++) store.remember(account.id, { id: `message-${i}`, jid, text, time: i + 1 });
    store.db.exec('COMMIT');
    const result = execFileSync(process.execPath, ['--max-old-space-size=64', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { Store } from ${JSON.stringify(new URL('../store.js', import.meta.url).href)};
      const store = new Store(process.argv[1]), account = process.argv[2];
      // More payload data than the entire heap budget: a full-history read cannot pass.
      for (let i = 0; i < 3; i++) {
        assert.equal(store.snapshotMessages(account).length, 200);
        assert.equal(store.messagePage(account, '${jid}').messages.length, 100);
        assert.equal(store.message(account, 'message-0').id, 'message-0');
      }
      store.close(); console.log('bounded-history-ok');
    `, dir, account.id], { encoding: 'utf8', timeout: 45000 });
    assert.match(result, /bounded-history-ok/);
    assert.equal(store.messageSummary(account.id).messageCount, 4000);
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
