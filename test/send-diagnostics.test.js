import test from 'node:test';
import assert from 'node:assert/strict';
import { WaJsClient } from '../wa-js-client.js';
import { WhatsAppAccount } from '../whatsapp.js';
import { messageSendFailure } from '../send-diagnostics.js';
import { automationError } from '../automation.js';

const jid = '123456789@s.whatsapp.net';
function client(evaluate, options = {}) {
  const logs = [], receipts = [];
  const instance = new WaJsClient({ profileDir: '/tmp/unused', onEvent: event => receipts.push(event), logSendFailure: entry => logs.push(entry), ...options });
  instance.page = { evaluate };
  return { instance, logs, receipts };
}

test('send failures have safe public codes and exclude raw messages, recipients and tokens from logs', async () => {
  const raw = new Error("Cannot read properties of undefined (reading 'serialize'); secret-token; customer body");
  const { instance, logs } = client(async () => { throw raw; });
  await assert.rejects(instance.sendText(jid, 'customer body'), error => {
    assert.equal(error.status, 502); assert.equal(error.publicCode, 'WHATSAPP_SEND_INCOMPATIBLE');
    assert.doesNotMatch(error.message, /secret-token|customer body/);
    assert.match(automationError(error), /WHATSAPP_SEND_INCOMPATIBLE/); return true;
  });
  assert.equal(logs.length, 1); assert.equal(logs[0].property, 'serialize');
  assert.doesNotMatch(JSON.stringify(logs), /secret-token|customer body|123456789/);
});

test('manual sends have a deadline, do not retry, and ignore late receipt results', async () => {
  let release, calls = 0;
  const { instance, receipts, logs } = client(() => { calls++; return new Promise(resolve => { release = resolve; }); }, { sendTimeout: 20 });
  await assert.rejects(instance.sendText(jid, 'hello'), error => error.status === 504 && error.publicCode === 'WHATSAPP_SEND_TIMEOUT');
  release({ id: 'true_123456789@c.us_LATE', ack: 1 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(receipts.length, 0); assert.equal(logs[0].code, 'WHATSAPP_SEND_TIMEOUT');
});

test('closed browsers and missing IDs are distinguished from storage failures', async () => {
  const { instance } = client(async () => ({}));
  await assert.rejects(instance.sendText(jid, 'hello'), error => error.publicCode === 'WHATSAPP_SEND_NO_ID');
  instance.closed = true;
  await assert.rejects(instance.sendText(jid, 'hello'), error => error.status === 503 && error.publicCode === 'WHATSAPP_SEND_DISCONNECTED');
  assert.equal(messageSendFailure(Error('other secret')).publicCode, 'WHATSAPP_SEND_FAILED');
});

test('successful submission followed by receipt/storage failure warns against duplicate sends', async () => {
  let calls = 0;
  const { instance } = client(async () => { calls++; return { id: 'true_123456789@c.us_SENT', ack: 1 }; }, { onEvent: () => { throw Error('private sqlite error'); } });
  await assert.rejects(instance.sendText(jid, 'hello'), error => {
    assert.equal(error.publicCode, 'SEND_RECORD_FAILED'); assert.match(error.message, /消息已提交/);
    assert.doesNotMatch(error.message, /private sqlite/); return true;
  });
  assert.equal(calls, 1);
  assert.throws(() => WhatsAppAccount.prototype.rememberSent.call({ remember: () => { throw Error('private database path'); } }, {}), error => error.publicCode === 'SEND_RECORD_FAILED');
});

test('text, image and file submissions preserve message IDs and receipt handling', async () => {
  const { instance, receipts } = client(async () => ({ id: 'true_123456789@c.us_MESSAGE', ack: 1 }));
  assert.equal(await instance.sendText(jid, 'hello'), 'MESSAGE');
  assert.equal(await instance.sendImage(jid, 'data:image/png;base64,AA==', 'caption'), 'MESSAGE');
  assert.equal(await instance.sendMedia(jid, Buffer.from('file'), { type: 'document', name: 'file.txt', mime: 'text/plain' }, 'caption'), 'MESSAGE');
  assert.equal(receipts.length, 3);
});


test('compatibility failures identify missing APIs without exposing whole exception messages', () => {
  for (const [raw, target] of [
    ['window.WPP.chat.sendTextMessage is not a function; customer body', 'window.WPP.chat.sendTextMessage'],
    ['(0, a.isLidMigrated) is not a function', 'a.isLidMigrated'],
    ['Module not found: functions.addAndSendMsgToChat', 'functions.addAndSendMsgToChat'],
    ['WidFactory is not defined; secret-token', 'WidFactory']
  ]) {
    const failure = messageSendFailure(Error(raw));
    assert.equal(failure.target, target);
    assert.match(failure.message, /API:/);
    assert.doesNotMatch(failure.message, /secret-token|customer body/);
  }
});
