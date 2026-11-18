// Runs inside the WhatsApp page. WA-JS 4.8.1 getMyUserLid calls a removed
// UserPrefs getter. The existing optional getter returns the same native user Wid.
export function installIdentityCompatibility() {
  let prefs;
  try { prefs = window.WPP?.whatsapp?.UserPrefs; }
  catch { return { state: 'unavailable' }; }
  if (!prefs) return { state: 'unavailable' };
  if (typeof prefs.getMeLidUserOrThrow === 'function') {
    return { state: prefs.getMeLidUserOrThrow.__blueLidAlias ? 'installed' : 'native' };
  }
  let source = prefs;
  if (typeof source.getMaybeMeLidUser !== 'function') {
    // Some WhatsApp builds split PN and LID preferences into separate modules.
    // Resolve the same named native getter, not a fabricated identity fallback.
    try { source = window.WPP.loader?.search(module => typeof module?.getMaybeMeLidUser === 'function'); }
    catch { source = null; }
  }
  if (typeof source?.getMaybeMeLidUser !== 'function') return { state: 'missing_native_getter' };
  const getLid = function () {
    const wid = source.getMaybeMeLidUser();
    let id;
    try { id = wid?._serialized || wid?.toString?.(); } catch { /* Fail closed below. */ }
    if (!wid || typeof wid !== 'object' || typeof id !== 'string' || !/^\d+@lid$/.test(id)) {
      throw new Error('WA_LOCAL_LID_UNAVAILABLE');
    }
    return wid;
  };
  getLid.__blueLidAlias = true;
  try {
    Object.defineProperty(prefs, 'getMeLidUserOrThrow', { value: getLid, configurable: true, writable: true });
    return { state: 'installed' };
  } catch { return { state: 'readonly_native_module' }; }
}
