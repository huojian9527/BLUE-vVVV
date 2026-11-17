import test from 'node:test';
import { generateCodes, activationHash } from '../scripts/generate-activation-codes.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store, entitlement } from '../store.js';
import { WhatsAppAccount } from '../whatsapp.js';

test('subscription expiry blocks account creation and sends; messages stay isolated and survive reopen', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-store-'));
  let store = new Store(dir);
  let runtime;
  try {
    await store.bootstrap('admin-user', 'a-long-password-123');
    const user = await store.createUser('test-user', 'a-long-password-123');
    const actor = store.byName('admin-user').id;
    store.grant(actor, user.id, { enabled: true, plan: 'pro', expiresAt: new Date(Date.now() + 86400000).toISOString() });
    const a = store.createAccount(user.id, 'First'), b = store.createAccount(user.id, 'Second');
    const message = { id: '1', jid: '123456789@s.whatsapp.net', text: 'Private', time: Date.now() };
    assert.equal(store.remember(a.id, message), true); assert.equal(store.remember(a.id, message), false);
    assert.deepEqual(store.messages(b.id), []);
    store.remember(a.id, { id: 'IMAGE', jid: message.jid, text: '/9j/' + 'A'.repeat(200), outgoing: true, time: Date.now() });
    assert.equal(store.messages(a.id).find(m => m.id === 'IMAGE').text, '[图片]', 'legacy base64 must not be exposed as chat text');
    assert.equal(store.remember(a.id, { id: 'IMAGE', jid: message.jid, text: '产品文案', image: 'a'.repeat(32) + '.png', buttons: [{ label: '咨询' }], outgoing: true, automatic: true, time: Date.now() }), true);
    const media = store.messages(a.id).find(m => m.id === 'IMAGE');
    assert.equal(media.text, '产品文案'); assert.equal(media.image, 'a'.repeat(32) + '.png'); assert.equal(media.buttons[0].label, '咨询');
    assert.equal(store.remember(a.id, { id: 'IMAGE', jid: message.jid, text: '/9j/' + 'A'.repeat(200), outgoing: true, time: Date.now() }), false, 'later browser echo must not replace the canonical reply');

    const menu = { nodeId: 'welcome', options: [{ label: 'Product', next: 'product' }] };
    store.remember(a.id, { id: 'OLD-MENU', jid: message.jid, text: 'Choose', buttons: [{ label: 'Product' }], flow: menu, outgoing: true, automatic: true, time: Date.now() - 86400000 });
    assert.deepEqual(store.flowMenu(a.id, message.jid, 'welcome', 'OLD-MENU', []), menu);
    assert.equal(store.flowMenu(b.id, message.jid, 'welcome', 'OLD-MENU', []), null);
    assert.equal(store.flowMenu(a.id, '987654321@s.whatsapp.net', 'welcome', 'OLD-MENU', []), null);
    assert.equal(store.flowMenu(a.id, message.jid, 'welcome', 'unknown', []), null);
    store.remember(a.id, { id: 'LEGACY-MENU', jid: message.jid, text: 'Choose', buttons: [{ label: 'Product' }], outgoing: true, automatic: true, time: Date.now() - 5000 });
    const legacyNodes = [{ id: 'welcome', options: menu.options }];
    assert.deepEqual(store.flowMenu(a.id, message.jid, 'welcome', 'LEGACY-MENU', legacyNodes), menu);
    assert.equal(store.flowMenu(a.id, message.jid, 'welcome', 'LEGACY-MENU', [{ id: 'welcome', options: [{ label: 'Different', next: 'product' }] }]), null);

    runtime = await new WhatsAppAccount(a, store, dir).init();
    let ended = false;
    runtime.client = { close: async () => { ended = true; } }; runtime.state.status = 'connected'; runtime.state.user = { id: '123456789@s.whatsapp.net' };
    runtime.requireConnected();
    store.db.prepare('UPDATE users SET expires_at=? WHERE id=?').run(Date.now() - 1, user.id);
    assert.equal(entitlement(store.user(user.id)).active, false);
    assert.equal(store.allowed(a), false);
    assert.throws(() => runtime.requireConnected(), /订阅/);
    assert.throws(() => store.createAccount(user.id, 'Expired'), /订阅/);
    await assert.rejects(runtime.connect(), /权限/);
    await runtime.stop('blocked'); assert.equal(ended, true); assert.equal(runtime.client, null);
    store.close(); store = new Store(dir);
    assert.equal(store.messages(a.id).find(item => item.id === '1').text, 'Private'); assert.equal(store.messages(b.id).length, 0);
    assert.deepEqual(store.flowMenu(a.id, message.jid, 'welcome', 'OLD-MENU', []), menu, 'old buttons survive process restart');
    assert.ok(store.byName('test-user').password_hash !== 'a-long-password-123');
    assert.throws(() => store.grant(actor, user.id, { enabled: true, plan: 'vip', expiresAt: new Date(Date.now() - 1).toISOString() }), /未来/);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});


test('contact remarks and monotonic read markers persist per account and cascade on deletion', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-contacts-')); let store = new Store(dir);
  try {
    await store.bootstrap('contact-admin', '123456'); const user = store.byName('contact-admin');
    const a = store.createAccount(user.id, 'One'), b = store.createAccount(user.id, 'Two'), jid = '123456789@s.whatsapp.net';
    store.updateContact(a.id, jid, { remark: '客户甲', readAt: 1000, name: 'Rose', phone: '123456789' });
    store.updateContact(a.id, jid, { readAt: 500 });
    assert.equal(store.contacts(a.id)[0].readAt, 1000);
    assert.deepEqual(store.contacts(b.id), []);
    store.close(); store = new Store(dir);
    assert.equal(store.contacts(a.id)[0].remark, '客户甲');
    store.updateContact(a.id, jid, { remark: '' }); assert.equal(store.contacts(a.id)[0].name, 'Rose');
    store.deleteAccount(a.id); assert.deepEqual(store.contacts(a.id), []);
  } finally { store.close(); await rm(dir, { recursive: true }); }
});


test('legacy schema migrates without moving ownership or changing plan limits; managed profiles keep their storage owner', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-legacy-assignment-')); let store = new Store(dir); let runtime;
  try {
    await store.bootstrap('legacy-admin', '123456'); const admin = store.byName('legacy-admin');
    const user = await store.createUser('legacy-customer', '123456');
    store.grant(admin.id, user.id, { enabled: true, plan: 'pro', expiresAt: new Date(Date.now() + 86400000).toISOString() });
    const old = store.createAccount(user.id, 'Legacy');
    store.db.exec('ALTER TABLE users DROP COLUMN number_limit; ALTER TABLE accounts DROP COLUMN storage_owner_id; ALTER TABLE accounts DROP COLUMN managed');
    store.close(); store = new Store(dir);
    assert.equal(store.publicUser(store.user(user.id)).limit, 5); assert.equal(store.account(old.id).managed, 0); assert.equal(store.account(old.id).storage_owner_id, user.id);
    assert.equal(store.canAccess(user.id, old), true);
    const batch = generateCodes(1); store.importActivationBatch({ batchId: batch.batchId, createdAt: new Date().toISOString(), hashes: batch.codes.map(activationHash) });
    const pool = store.createManaged(admin.id, 'Pooled', batch.codes[0]); runtime = await new WhatsAppAccount(pool, store, dir).init();
    const profile = runtime.profileDir; let closed = 0; const client = { close: async () => { closed++; } }; runtime.client = client; runtime.state.status = 'connected'; runtime.state.user = { id: '123456789@s.whatsapp.net' };
    runtime.account = store.assignAccount(admin.id, pool.id, user.id);
    assert.equal(runtime.profileDir, profile); assert.equal(runtime.client, client); assert.equal(store.canAccess(admin.id, pool), false); assert.equal(store.canAccess(user.id, pool), true);
    runtime.account = store.assignAccount(admin.id, pool.id, null);
    assert.equal(store.canAccess(user.id, pool), false); assert.equal(store.allowed(pool), true); assert.equal(runtime.state.status, 'connected'); assert.equal(closed, 0);
    assert.equal(store.canAccess(user.id, old), true, 'legacy number remains unchanged');
  } finally { await runtime?.stop(); store.close(); await rm(dir, { recursive: true }); }
});


test('late message enrichment replaces placeholders while preserving downloaded attachments and rich messages', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-enrichment-')); const store = new Store(dir);
  try {
    await store.bootstrap('enrich-admin', '123456'); const account = store.createAccount(store.byName('enrich-admin').id, 'Test');
    const base = { id: 'LATE', jid: '123456789@s.whatsapp.net', time: Date.now(), outgoing: false, text: '[视频]', messageType: 'video', attachment: { id: 'a'.repeat(32) } };
    store.remember(account.id, base);
    assert.equal(store.remember(account.id, { id: base.id, jid: base.jid, time: base.time, text: '迟到的文案', messageType: 'video' }), true);
    // Real normalized events omit attachment, rather than assigning undefined.
    const next = { ...base, text: '完整内容' }; delete next.attachment;
    const old = { ...base, id: 'PLAIN', text: '[非文本消息]', messageType: 'unknown' };
    store.remember(account.id, old); store.remember(account.id, { ...next, id: 'PLAIN', messageType: 'chat' });
    const repaired = store.messages(account.id).find(item => item.id === 'PLAIN');
    assert.equal(repaired.text, '完整内容'); assert.equal(repaired.attachment.id, base.attachment.id);
    store.remember(account.id, { ...old, messageType: 'chat' });
    assert.equal(store.messages(account.id).find(item => item.id === 'PLAIN').text, '完整内容');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});


test('message history has no count cutoff and survives duplicate imports, reopen and partial sync', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-history-'));
  let store = new Store(dir), runtime;
  try {
    await store.bootstrap('history-admin', 'history-password-123');
    const user = store.byName('history-admin');
    const a = store.createAccount(user.id, 'History'), b = store.createAccount(user.id, 'Isolated');
    const baseTime = Date.now() - 86400000;
    const entries = Array.from({ length: 650 }, (_, i) => ({ id: 'history-' + i, messageType: 'chat', jid: (i % 2 ? '123456789' : '987654321') + '@s.whatsapp.net', text: 'Message ' + i, time: baseTime + i * 1000 }));
    store.db.exec('BEGIN');
    for (const entry of entries.slice(0, 100)) store.remember(a.id, entry);
    assert.deepEqual(store.messages(a.id), entries.slice(0, 100), 'a small history is retained too');
    for (const entry of entries.slice(100)) store.remember(a.id, entry);
    store.db.exec('COMMIT');
    assert.deepEqual(store.messages(a.id), entries);
    assert.deepEqual(store.messageSummary(a.id), { messageCount: 650, conversationCount: 2, oldestMessageAt: entries[0].time, newestMessageAt: entries[649].time, automaticCountLimit: null });
    assert.equal(store.messageSummary(b.id).messageCount, 0);
    assert.deepEqual(store.messages(b.id), []);
    store.remember(a.id, entries[0]);
    assert.equal(store.messages(a.id).length, 650);
    store.close(); store = new Store(dir);
    assert.deepEqual(store.messages(a.id), entries);
    runtime = await new WhatsAppAccount(store.account(a.id), store, dir).init();
    runtime.state.status = 'connected'; runtime.state.user = { id: '123456789@c.us' };
    runtime.client = { close: async () => {}, fetchMessages: async () => ({ messages: [{ id: entries[649].id, chatId: '123456789@c.us', body: entries[649].text, timestamp: entries[649].time / 1000 }], chatCount: 1, failedChats: 0 }) };
    await runtime.syncMessages();
    assert.deepEqual(store.messages(a.id), entries, 'partial history imports never replace complete stored history');
    runtime.client.fetchMessages = async () => ({ messages: [], chatCount: 0, failedChats: 0 });
    await runtime.syncMessages();
    assert.equal(runtime.snapshot().messages.length, 200, 'live snapshots contain a recent window instead of the full history');
    assert.equal(store.messages(a.id).length, 650, 'empty history imports do not clear stored messages');
    assert.deepEqual(store.messages(b.id), []);
  } finally { await runtime?.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('admin conversation statistics deduplicate per number and use Beijing day boundaries and current ownership', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blue-conversations-'));
  const store = new Store(dir);
  try {
    await store.bootstrap('stats-admin', 'stats-password-123');
    const admin = store.byName('stats-admin');
    const alice = await store.createUser('stats-alice', 'stats-password-123');
    const bob = await store.createUser('stats-bob', 'stats-password-123');
    store.grant(admin.id, alice.id, { enabled: true, plan: 'pro', expiresAt: new Date(Date.now() + 86400000).toISOString() });
    const a = store.createAccount(alice.id, 'One'), b = store.createAccount(alice.id, 'Two');
    const start = Date.parse('2026-11-03T16:00:00Z'), now = start + 3600000;
    let id = 0;
    const add = (account, jid, time, outgoing = false) => store.remember(account.id, { id: String(++id), jid: jid + '@s.whatsapp.net', time, text: 'Private content', outgoing });
    add(a, '123456789', start - 1);
    add(a, '123456789', start); add(a, '123456789', start + 1, true);
    add(a, '987654321', start - 1);
    add(a, '111111111', start + 86400000 - 1);
    add(a, '222222222', start + 86400000);
    add(b, '123456789', start);
    const stats = user => store.users(now).find(u => u.id === user.id).conversations;
    assert.deepEqual(stats(alice), { today: 3, total: 5, date: '2026-11-04', timeZone: 'Asia/Shanghai' });
    assert.equal(stats(bob).total, 0);
    assert.equal(JSON.stringify(store.users(now)).includes('Private content'), false);
    store.db.prepare('UPDATE accounts SET user_id=?,managed=2 WHERE id=?').run(bob.id, b.id);
    assert.equal(stats(alice).total, 4); assert.equal(stats(alice).today, 2);
    assert.equal(stats(bob).total, 1); assert.equal(stats(bob).today, 1);
    store.db.prepare('UPDATE accounts SET managed=1 WHERE id=?').run(b.id);
    assert.equal(stats(bob).total, 0, 'unassigned managed numbers are excluded');
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});
