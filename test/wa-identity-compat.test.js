import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { installIdentityCompatibility } from '../wa-identity-compat.js';
const install = prefs => vm.runInNewContext(`(${installIdentityCompatibility.toString()})()`, { window: { WPP: { whatsapp: { UserPrefs: prefs } } } });

test('missing strict LID getter delegates to the original native optional user getter', () => {
  const lid = { _serialized: '998877@lid' }, pn = { _serialized: '123456789@c.us' };
  const prefs = { getMaybeMeLidUser: () => lid, getMaybeMePnUser: () => pn };
  assert.equal(install(prefs).state, 'installed');
  assert.equal(prefs.getMeLidUserOrThrow(), lid, 'preserve the native Wid instance');
  const alias = prefs.getMeLidUserOrThrow;
  assert.equal(install(prefs).state, 'installed'); assert.equal(prefs.getMeLidUserOrThrow, alias);
});

test('native strict getter is preserved unchanged', () => {
  const original = () => ({ _serialized: '998877@lid' });
  const prefs = { getMeLidUserOrThrow: original };
  assert.equal(install(prefs).state, 'native'); assert.equal(prefs.getMeLidUserOrThrow, original);
});

test('missing, PN, device-qualified or string identities are never substituted for native user LID', () => {
  for (const wid of [null, { _serialized: '123456789@c.us' }, { _serialized: '998877:2@lid' }, '998877@lid', {}]) {
    const prefs = { getMaybeMeLidUser: () => wid, getMaybeMePnUser: () => ({ _serialized: '123456789@c.us' }) };
    assert.equal(install(prefs).state, 'installed');
    assert.throws(() => prefs.getMeLidUserOrThrow(), /WA_LOCAL_LID_UNAVAILABLE/);
  }
});

test('native LID toString remains supported without fabricating an identity', () => {
  const lid = { toString: () => '998877@lid' };
  const prefs = { getMaybeMeLidUser: () => lid };
  install(prefs); assert.equal(prefs.getMeLidUserOrThrow(), lid);
});

test('unavailable and sealed native modules fail closed', () => {
  assert.equal(install(undefined).state, 'unavailable');
  assert.equal(install({}).state, 'missing_native_getter');
  const prefs = Object.freeze({ getMaybeMeLidUser: () => ({ _serialized: '998877@lid' }) });
  assert.equal(install(prefs).state, 'readonly_native_module');
  assert.equal(prefs.getMeLidUserOrThrow, undefined);
});


test('a split native LID module is resolved by its explicit getter name', () => {
  const lid = { _serialized: '998877@lid' }, prefs = { getMaybeMePnUser: () => ({ _serialized: '123456789@c.us' }) };
  const nativeLidModule = { getMaybeMeLidUser: () => lid };
  const result = vm.runInNewContext(`(${installIdentityCompatibility.toString()})()`, { window: { WPP: { whatsapp: { UserPrefs: prefs }, loader: { search: condition => condition(nativeLidModule) ? nativeLidModule : null } } } });
  assert.equal(result.state, 'installed'); assert.equal(prefs.getMeLidUserOrThrow(), lid);
});
