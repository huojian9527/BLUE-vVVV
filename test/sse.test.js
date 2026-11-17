import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openEvents, writeEvent, closeEvents } from '../sse.js';
import { WhatsAppAccount } from '../whatsapp.js';

class Response extends EventEmitter {
  destroyed = false; writableEnded = false; frames = []; blocked = false;
  write(frame) {
    assert.equal(this.writableEnded, false, 'never write after end');
    assert.equal(this.destroyed, false, 'never write after destroy');
    this.frames.push(frame); return !this.blocked;
  }
  end() { this.writableEnded = true; this.emit('finish'); }
  destroy() { this.destroyed = true; this.emit('close'); }
}
const runtime = () => ({ clients: new Map(), snapshot: () => ({ messages: [], account: {} }) });

test('SSE stops heartbeats and subscriptions on finish, close and late write errors', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  for (const ending of ['finish', 'close', 'error']) {
    const rt = runtime(), res = new Response();
    openEvents(rt, res, () => true);
    assert.equal(rt.clients.size, 1);
    t.mock.timers.tick(10000); assert.equal(res.frames.length, 2);
    if (ending === 'finish') res.end();
    else if (ending === 'close') res.destroy();
    else res.emit('error', Error('write after end'));
    assert.equal(rt.clients.size, 0);
    t.mock.timers.tick(30000); assert.equal(res.frames.length, 2);
    res.emit('error', Error('late asynchronous write error'));
    assert.equal(writeEvent(res, 'late'), false);
  }
});

test('SSE backpressure discards slow clients without accumulating queued snapshots', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const rt = runtime(), res = new Response();
  openEvents(rt, res, () => true);
  res.blocked = true;
  assert.equal(writeEvent(res, 'one blocked frame'), true);
  assert.equal(res.destroyed, false, 'allow a single large frame to drain');
  assert.equal(writeEvent(res, 'never appended'), false);
  assert.equal(res.destroyed, true); assert.equal(rt.clients.size, 0);
  for (let i = 0; i < 100; i++) writeEvent(res, 'never queued');
  t.mock.timers.tick(30000); assert.equal(res.frames.length, 2);
});

test('revocation and runtime shutdown clear the timer before ending SSE', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const rt = runtime(), res = new Response(); let valid = true;
  openEvents(rt, res, () => valid); valid = false;
  WhatsAppAccount.prototype.broadcast.call(rt);
  assert.match(res.frames.at(-1), /event: revoked/);
  assert.equal(res.writableEnded, true); assert.equal(rt.clients.size, 0);
  t.mock.timers.tick(30000); assert.equal(res.frames.length, 2);
  const next = new Response(); openEvents(rt, next, () => true); closeEvents(next);
  t.mock.timers.tick(30000); assert.equal(next.frames.length, 1);
});

test('SSE isolates synchronous write failures and serializes once per role per broadcast', () => {
  const rt = runtime(); let snapshots = 0;
  rt.snapshot = role => { snapshots++; return { role }; };
  const bad = new Response(); openEvents(rt, bad, () => true);
  bad.write = () => { throw Error('socket write failed'); };
  const good = new Response(), other = new Response();
  openEvents(rt, good, () => true); openEvents(rt, other, () => true);
  snapshots = 0; WhatsAppAccount.prototype.broadcast.call(rt);
  assert.equal(snapshots, 1); assert.equal(rt.clients.size, 2); assert.equal(bad.destroyed, true);
  closeEvents(good); closeEvents(other);
});

test('a healthy large SSE frame can drain; a stalled frame times out without more writes', t => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout'] });
  const rt = runtime(), res = new Response();
  openEvents(rt, res, () => true);
  res.blocked = true; assert.equal(writeEvent(res, 'large frame'), true);
  res.emit('drain'); res.blocked = false;
  assert.equal(writeEvent(res, 'next frame'), true);
  closeEvents(res);
  const stalled = new Response();
  openEvents(rt, stalled, () => true, 60000);
  stalled.blocked = true; writeEvent(stalled, 'stalled frame');
  t.mock.timers.tick(15000);
  assert.equal(stalled.destroyed, true); assert.equal(rt.clients.size, 0);
  assert.equal(stalled.listenerCount('drain'), 0);
});
