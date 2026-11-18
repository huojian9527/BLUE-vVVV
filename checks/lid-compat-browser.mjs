import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { browserExecutable, waScript, WaJsClient } from '../wa-js-client.js';
import { installIdentityCompatibility } from '../wa-identity-compat.js';

const browser = await puppeteer.launch({ executablePath: await browserExecutable(), headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  await page.addScriptTag({ path: waScript });
  // Bind a native-module fixture through the pinned bundle's real loader.
  // Keep WPP.conn.getMyUserLid itself unmodified to reproduce the deployed error.
  await page.evaluate(() => {
    window.nativeLid = { _serialized: '998877@lid' };
    const prefs = { getMaybeMePnUser: () => ({ _serialized: '123456789@c.us' }), getMaybeMeLidUser: () => window.nativeLid };
    const require = () => prefs; require.m = { native_user_prefs: () => {} };
    window.WPP.loader.moduleRequire = require;
  });
  await assert.rejects(page.evaluate(() => window.WPP.conn.getMyUserLid()), /getMeLidUserOrThrow is not a function/);
  assert.equal((await page.evaluate(installIdentityCompatibility)).state, 'installed');
  assert.equal(await page.evaluate(() => window.WPP.conn.getMyUserLid() === window.nativeLid), true);
  assert.equal((await page.evaluate(installIdentityCompatibility)).state, 'installed');
  // Exercise the application's pre-send hook on a fresh missing-getter state.
  await page.evaluate(() => {
    delete window.WPP.whatsapp.UserPrefs.getMeLidUserOrThrow;
    window.sendAttempts = 0;
    window.fixtureSend = async () => {
      window.sendAttempts++;
      if (window.WPP.conn.getMyUserLid() !== window.nativeLid) throw Error('Wrong native identity');
      return { id: 'true_123456789@c.us_COMPAT', ack: 1 };
    };
  });
  const receipts = [];
  const client = new WaJsClient({ profileDir: '/tmp/unused-lid-fixture', onEvent: event => receipts.push(event), logSendFailure: () => {} });
  client.page = { evaluate: (fn, payload) => fn.name === 'installIdentityCompatibility' ? page.evaluate(fn) : page.evaluate(() => window.fixtureSend()) };
  assert.equal(await client.sendText('123456789@s.whatsapp.net', 'fixture'), 'COMPAT');
  assert.equal(receipts.length, 1); assert.equal(client.identityCompatibility.state, 'installed');
  assert.equal(await page.evaluate(() => window.sendAttempts), 1);
  await page.evaluate(() => { window.nativeLid = null; });
  await assert.rejects(client.sendText('123456789@s.whatsapp.net', 'fixture'), error => error.publicCode === 'WHATSAPP_IDENTITY_UNAVAILABLE');
  console.log('PASS: the pinned WA-JS getter reproduces the production missing-LID error; the compatibility hook restores the native Wid and rejects unavailable identity. No real messages sent.');
} finally { await browser.close(); }
