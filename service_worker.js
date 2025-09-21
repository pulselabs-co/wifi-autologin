// service_worker.js - full file (ready to replace)
// WiFi AutoLogin - MV3 service worker
// - authoritative generate_204 probe
// - keepalive detection to avoid backoff escalation while a keepalive page exists
// - friendly backoff policy
// - createdTab tracking to only close tabs we created
// - minimal noisy logging unless DEBUG=true

'use strict';

const DEBUG = false; // set true while testing
const DEFAULT_UNLOCK_MINUTES = 60;

let cachedConfig = null;
let clearTimerId = null;
let backoffSeconds = 0;

// probe/tab state
let probeTabId = null;
let lastProbeTime = 0;
const PROBE_COOLDOWN_MS = 15 * 1000; // 15s cooldown (tune to 30s/60s for less probe activity)
const PROBE_URL = 'http://neverssl.com/';

// tuning
const MAX_FIELD_CHECK_TRIES = 3;
const FIELD_CHECK_INTERVAL_MS = 1200;
const RELOAD_ON_FIRST_FAIL = true;
const NOTIFY_SUCCESS_COOLDOWN_MS = 3 * 60 * 1000; // throttle success notifications per origin

// state trackers
const failedAttemptsByOrigin = {};
const lastSuccessNotifiedAt = {};
const createdTabIds = new Set();
const inFlightOrigins = new Set();

function log(...args){ if (DEBUG) console.log('[worker]', ...args); }
function warn(...args){ console.warn('[worker]', ...args); }
function info(...args){ if (DEBUG) console.log('[worker]', ...args); }

// load persisted cfg at startup (if persisted via popup "Remember me")
try {
  if (chrome && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get(['cfg'], (res) => {
      try {
        if (res && res.cfg) {
          cachedConfig = res.cfg;
          info('Loaded persisted cfg at startup:', { loginUrl: cachedConfig.loginUrl, userField: cachedConfig.userField });
        } else {
          log('No persisted cfg at startup.');
        }
      } catch (e) {
        warn('Error reading persisted cfg', e);
      }
    });
  }
} catch (e) {
  warn('chrome.storage not available at startup', e);
}

// Helpers
function originOf(urlStr) {
  try { return new URL(urlStr).origin; } catch (e) { return urlStr || ''; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// merge two AbortSignals into one (abort if either aborts)
function mergeAbortSignals(sigA, sigB) {
  if (!sigA) return sigB;
  if (!sigB) return sigA;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (sigA.aborted || sigB.aborted) { ac.abort(); return ac.signal; }
  sigA.addEventListener('abort', onAbort);
  sigB.addEventListener('abort', onAbort);
  return ac.signal;
}

// fetch with timeout helper
async function fetchWithTimeout(url, externalSignal = null, timeoutMs = 2000) {
  const ac = new AbortController();
  const signal = ac.signal;
  const combined = externalSignal ? mergeAbortSignals(externalSignal, signal) : signal;
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', cache: 'no-store', redirect: 'follow', signal: combined });
    clearTimeout(timer);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// Authoritative connectivity check using generate_204 (avoid captive-portal false positives).
// Small retry to reduce transient false-negatives.
async function isInternetUp(timeoutMs = 2000) {
  try {
    const res = await fetchWithTimeout('http://clients3.google.com/generate_204', null, timeoutMs);
    if (res && res.status === 204) return true;
  } catch (e) {
    // ignore, retry below
  }
  try {
    await sleep(300);
    const r2 = await fetchWithTimeout('http://clients3.google.com/generate_204', null, timeoutMs);
    return !!(r2 && r2.status === 204);
  } catch (e) {
    return false;
  }
}

// wait until a tab reaches 'complete' or timeout
async function waitForTabLoaded(tabId, timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (!t) return false;
      if (t.status === 'complete') return true;
    } catch (e) {
      return false;
    }
    await sleep(300);
  }
  return false;
}

// cache config in worker memory (set by popup)
function cacheConfig(cfg) {
  cachedConfig = cfg || null;
  if (clearTimerId) { clearTimeout(clearTimerId); clearTimerId = null; }
  info('Cached config set:', { loginUrl: cfg && cfg.loginUrl, userField: cfg && cfg.userField });
}

// alarms: periodic check
chrome.alarms.create('checkConn', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'checkConn') {
    log('Alarm fired: checkConn');
    await checkAndLogin(false);
  }
});

// message handling from popup and content scripts
chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  (async () => {
    try {
      log('Received message:', msg && msg.type);
      if (msg.type === 'setPlainConfig') {
        cacheConfig(msg.cfg);
        respond({ ok: true });
      } else if (msg.type === 'doLoginNow') {
        const ok = await checkAndLogin(true);
        respond({ ok });
      } else if (msg.type === 'clearCache') {
        cachedConfig = null;
        if (clearTimerId) { clearTimeout(clearTimerId); clearTimerId = null; }
        try { chrome.storage.local.remove(['cfg']); } catch (e) { /* ignore */ }
        respond({ ok: true });
      } else if (msg.type === 'page_is_portal') {
        log('page_is_portal message, origin=', msg.origin);
        try {
          if (cachedConfig && originOf(cachedConfig.loginUrl) === msg.origin) {
            log('portal origin matches cached config; running immediate login.');
            const result = await checkAndLogin(true);
            respond({ ok: result });
          } else {
            respond({ ok: false, error: 'no_cached_match' });
          }
        } catch (e) {
          respond({ ok: false, error: String(e) });
        }
      } else {
        respond({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      warn('onMessage handler error', e);
      respond({ ok: false, error: String(e) });
    }
  })();
  return true;
});

// detect presence of username & password fields across frames
async function detectFieldsInTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        try {
          const inputs = Array.from(document.querySelectorAll('input'));
          const inputInfo = inputs.slice(0, 40).map(i => ({ name: i.name || '', id: i.id || '', type: i.type || '', placeholder: i.placeholder || '' }));
          const hasPass = inputs.some(i => (i.type || '').toLowerCase() === 'password');
          const hasUser = inputs.some(i => {
            const meta = ((i.name || '') + ' ' + (i.id || '') + ' ' + (i.placeholder || '')).toLowerCase();
            return /user|login|email|username|id/.test(meta) || (i.type === 'text' || i.type === 'email');
          });
          return { docUrl: location.href, found: (hasPass && hasUser), inputs: inputInfo };
        } catch (e) {
          return { docUrl: (location && location.href) || '(unknown)', found: false, error: String(e) };
        }
      }
    });

    const frames = (results || []).map(r => r && r.result ? r.result : { docUrl: '(unknown)', found: false });
    const foundAny = frames.some(f => f && f.found);
    return { found: foundAny, frames };
  } catch (e) {
    warn('detectFieldsInTab error', e);
    return { found: false, frames: [] };
  }
}

// determines whether a tab is a keepalive page (heuristics and small in-page check)
async function isKeepaliveTab(tab) {
  try {
    if (!tab || !tab.id) return false;
    if (tab.url && tab.url.toLowerCase().includes('keepalive')) return true;

    const res = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: false },
      func: () => {
        try {
          const text = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
          return /keepalive|authentication keepalive|authentication keep-alive|authentication refresh/i.test(text);
        } catch (e) {
          return false;
        }
      }
    });
    return !!(res && Array.isArray(res) && res[0] && res[0].result);
  } catch (e) {
    return false;
  }
}

// open portal/probe tab, detect fields, inject credentials
async function openPortalTabAndSubmit(cfg) {
  const origin = originOf(cfg.loginUrl || '') || cfg.loginUrl || '';
  log('openPortalTabAndSubmit starting. origin=', origin);

  // Quick guard: if internet is already up, skip opening tab
  try {
    if (await isInternetUp()) {
      log('openPortalTabAndSubmit: internet appears up already, skipping tab open.');
      return { ok: false, error: 'already_up' };
    }
  } catch (e) {
    warn('connectivity guard error (continuing):', e);
  }

  // find existing portal tab
  const tabs = await chrome.tabs.query({});
  let portalTab = tabs.find(t => {
    try { return t.url && (new URL(t.url).origin === origin); }
    catch (e) { return false; }
  });

  let createdTabId = null;

  if (portalTab) {
    log('Reusing existing portal tab id=', portalTab.id, 'url=', portalTab.url);
    try { await chrome.tabs.update(portalTab.id, { active: false }); } catch (e) { /* ignore */ }
  } else {
    // create/reuse probe
    const now = Date.now();
    if (probeTabId) {
      try {
        const t = await chrome.tabs.get(probeTabId);
        if (!t || (t && t.url && t.url.startsWith('chrome://'))) probeTabId = null;
      } catch (e) { probeTabId = null; }
    }

    if (!probeTabId && (now - lastProbeTime) >= PROBE_COOLDOWN_MS) {
      try {
        const created = await chrome.tabs.create({ url: PROBE_URL, active: false });
        probeTabId = created.id;
        createdTabIds.add(probeTabId);
        lastProbeTime = Date.now();
        createdTabId = probeTabId;
        log('Created probe tab id=', probeTabId, 'url=', PROBE_URL);
        await waitForTabLoaded(probeTabId, 15000);
      } catch (e) {
        warn('probe tab create failed', e);
        probeTabId = null;
      }
    } else {
      log('Probe in cooldown or already exists.');
    }

    // check if probe redirected to portal
    try {
      const tabs2 = await chrome.tabs.query({});
      portalTab = tabs2.find(t => {
        try { return t.url && (new URL(t.url).origin === origin); }
        catch (e) { return false; }
      });
    } catch (e) { warn('tabs.query after probe failed', e); }

    // navigate probe tab to origin if needed (but recheck connectivity first)
    if (!portalTab && probeTabId) {
      try {
        try {
          if (await isInternetUp()) {
            log('probe navigation skipped: internet already up.');
            return { ok: false, error: 'already_up' };
          }
        } catch (e) { /* ignore */ }

        log('Navigating probe tab to portal origin in background:', origin);
        await chrome.tabs.update(probeTabId, { url: origin, active: false });
        await waitForTabLoaded(probeTabId, 15000);
        try { portalTab = await chrome.tabs.get(probeTabId); } catch (e) {}
        if (portalTab && (new URL(portalTab.url).origin === origin)) {
          log('Probe tab navigated to portal origin and is now portalTab id=', portalTab.id);
        }
      } catch (e) {
        warn('Could not navigate probe tab to origin', e);
      }
    }

    // last resort: create background portal tab
    if (!portalTab) {
      try {
        const created = await chrome.tabs.create({ url: origin, active: false });
        portalTab = created;
        createdTabId = created.id;
        createdTabIds.add(createdTabId);
        log('Created background portal tab id=', createdTabId, 'url=', origin);
        await waitForTabLoaded(createdTabId, 15000);
      } catch (e) {
        warn('tab_create_failed for origin', e);
        return { ok: false, error: 'tab_create_failed:' + e.toString() };
      }
    }
  }

  if (!portalTab) {
    warn('No portal tab available after probe attempts.');
    return { ok: false, error: 'no_portal_tab' };
  }

  // pre-check for fields and retry
  let checkAttempt = 0;
  let detectResult = await detectFieldsInTab(portalTab.id);
  while (checkAttempt < MAX_FIELD_CHECK_TRIES && !detectResult.found) {
    log(`No fields found on attempt ${checkAttempt+1}/${MAX_FIELD_CHECK_TRIES} for tab ${portalTab.id}.`);
    if (RELOAD_ON_FIRST_FAIL && checkAttempt === 0) {
      try {
        log('Reloading portal tab to let portal JS run (first fail retry).');
        await chrome.tabs.reload(portalTab.id);
        await waitForTabLoaded(portalTab.id, 7000);
      } catch (e) { warn('reload attempt failed', e); }
    } else {
      await sleep(FIELD_CHECK_INTERVAL_MS);
    }
    detectResult = await detectFieldsInTab(portalTab.id);
    checkAttempt++;
  }

  if (!detectResult.found) {
    warn('fields not found after retries. frames:', detectResult.frames);
    return { ok: false, error: 'fields_not_found_in_all_frames', frames: detectResult.frames };
  }

  // injection across frames
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: portalTab.id, allFrames: true },
      func: (cfg) => {
        function tryFindAndSubmitInDocument(doc, cfg) {
          try {
            if (cfg.userField || cfg.passField) {
              let user = null, pass = null;
              if (cfg.userField) user = doc.querySelector(`[name="${cfg.userField}"], #${cfg.userField}`);
              if (cfg.passField) pass = doc.querySelector(`[name="${cfg.passField}"], #${cfg.passField}`);
              if (user || pass) {
                if (user) user.value = cfg.username || '';
                if (pass) pass.value = cfg.password || '';
                const form = (user && user.form) || (pass && pass.form) || doc.forms[0];
                if (form) {
                  if (cfg.extraFields) {
                    try {
                      const extras = JSON.parse(cfg.extraFields || '{}');
                      Object.keys(extras).forEach(k => {
                        let el = form.querySelector(`[name="${k}"]`);
                        if (!el) {
                          el = doc.createElement('input');
                          el.type = 'hidden';
                          el.name = k;
                          form.appendChild(el);
                        }
                        el.value = extras[k];
                      });
                    } catch (e) {}
                  }
                  const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
                  if (submitBtn) { submitBtn.click(); return { ok: true }; }
                  try { form.submit(); return { ok: true }; } catch (e) {}
                }
              }
            }
            const inputs = Array.from(doc.querySelectorAll('input'));
            let passCandidate = inputs.find(i => (i.type || '').toLowerCase() === 'password');
            let userCandidate = inputs.find(i => {
              const name = (i.name || '') + ' ' + (i.id || '') + ' ' + (i.placeholder || '');
              return /user|login|email|username|id/i.test(name) && (i.type === 'text' || i.type === 'email' || !i.type);
            });
            if (!userCandidate && inputs.length) userCandidate = inputs.find(i => (i.type || '').toLowerCase() !== 'password') || inputs[0];
            if (userCandidate && passCandidate) {
              userCandidate.value = cfg.username || '';
              passCandidate.value = cfg.password || '';
              const form = userCandidate.form || passCandidate.form || doc.forms[0];
              if (form) {
                if (cfg.extraFields) {
                  try {
                    const extras = JSON.parse(cfg.extraFields || '{}');
                    Object.keys(extras).forEach(k => {
                      let el = form.querySelector(`[name="${k}"]`);
                      if (!el) {
                        el = doc.createElement('input');
                        el.type = 'hidden';
                        el.name = k;
                        form.appendChild(el);
                      }
                      el.value = extras[k];
                    });
                  } catch (e) {}
                }
                const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
                if (submitBtn) { submitBtn.click(); return { ok: true }; }
                try { form.submit(); return { ok: true }; } catch (e) {}
              }
            }
            return { ok: false, error: 'fields_not_found', inputs: inputs.map(i => ({ name: i.name || '', id: i.id || '', type: i.type || '', placeholder: i.placeholder || '' })) };
          } catch (e) {
            return { ok: false, error: 'doc_error:' + String(e) };
          }
        }
        try {
          const res = tryFindAndSubmitInDocument(document, cfg);
          return { perFrame: res, docUrl: document.location.href };
        } catch (e) {
          return { perFrame: { ok: false, error: String(e) }, docUrl: document.location.href };
        }
      },
      args: [cfg]
    });

    const frameResults = results.map(r => r && r.result ? r.result : null);
    let successFrameIndex = -1;
    for (let i = 0; i < frameResults.length; i++) {
      const r = frameResults[i];
      if (r && r.perFrame && r.perFrame.ok) { successFrameIndex = i; break; }
    }

    if (successFrameIndex !== -1) {
      log('Injection succeeded in frame index', successFrameIndex, 'docUrl=', frameResults[successFrameIndex].docUrl);
      return { ok: true, frameIndex: successFrameIndex, docUrl: frameResults[successFrameIndex].docUrl, usedTabId: createdTabId };
    }

    const framesDebug = frameResults.map((fr, idx) => ({ idx, docUrl: fr && fr.docUrl ? fr.docUrl : '(unknown)', info: fr && fr.perFrame ? fr.perFrame : fr }));
    warn('No frame reported success after injection. Frame results:', framesDebug);
    return { ok: false, error: 'fields_not_found_in_all_frames', frames: framesDebug, usedTabId: createdTabId };

  } catch (e) {
    warn('scripting_inject_failed', e);
    return { ok: false, error: 'scripting_inject_failed:' + e.toString(), usedTabId: createdTabId };
  }
}

// main check & login logic with keepalive handling
async function checkAndLogin(force) {
  try {
    log('checkAndLogin called. force=', force, 'cachedConfigPresent=', !!cachedConfig);

    // Quick check: if not forcing and internet is up, nothing to do
    if (!force && await isInternetUp()) {
      log('Internet already up; nothing to do.');
      return true;
    }

    if (!cachedConfig) {
      chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title: 'WiFi AutoLogin', message: 'Auto-login locked: open popup and Save credentials to enable auto-login.' });
      log('No cachedConfig -> locked. Exiting check.');
      return false;
    }

    const cfg = cachedConfig;
    if (!cfg || !cfg.loginUrl) {
      warn('No loginUrl in cfg');
      return false;
    }

    const originKey = originOf(cfg.loginUrl || '');

    // dedupe: don't run overlapping attempts for same origin
    if (inFlightOrigins.has(originKey) && !force) {
      log('Another attempt already in flight for', originKey, '; skipping.');
      return false;
    }
    inFlightOrigins.add(originKey);

    try {
      // If we have backoff active, wait before attempting
      if (backoffSeconds > 0) {
        log('Backoff active; waiting', backoffSeconds, 's');
        await sleep(backoffSeconds * 1000);
      }

      // re-check connectivity again before heavy work
      if (!force && await isInternetUp()) {
        log('Internet recovered during wait; nothing to do.');
        inFlightOrigins.delete(originKey);
        return true;
      }

      // SPECIAL: If there's an existing portal tab and it's a keepalive page, avoid escalating backoff.
      try {
        const tabsAll = await chrome.tabs.query({});
        const maybeTab = tabsAll.find(t => {
          try { return t.url && (new URL(t.url).origin === originKey); } catch (e) { return false; }
        });
        if (maybeTab) {
          const keep = await isKeepaliveTab(maybeTab);
          if (keep) {
            log('Keepalive tab detected; do not escalate backoff. Will poll with short retry.');
            backoffSeconds = 5; // short steady retry
            inFlightOrigins.delete(originKey);
            return false;
          }
        }
      } catch (e) {
        log('Keepalive detect error (continuing):', e);
      }

      log('Attempting in-page submit for origin:', originKey);
      const submitRes = await openPortalTabAndSubmit(cfg);
      log('submitRes after injection:', submitRes);

      if (submitRes && submitRes.ok) {
        // small delay to let portal register authentication
        await sleep(2000);
        if (await isInternetUp()) {
          backoffSeconds = 0;
          failedAttemptsByOrigin[originKey] = 0;

          // throttle success notifications
          const now = Date.now();
          const last = lastSuccessNotifiedAt[originKey] || 0;
          if (now - last > NOTIFY_SUCCESS_COOLDOWN_MS) {
            chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title: 'WiFi AutoLogin', message: 'Auto-login succeeded — internet is reachable.' });
            lastSuccessNotifiedAt[originKey] = now;
          } else {
            log('Suppressing repeated success notification (cooldown).');
          }

          // close tab we created during this attempt (only if we created it)
          try {
            const tid = submitRes.usedTabId;
            if (tid && createdTabIds.has(tid)) {
              log('Closing created probe/portal tab id=', tid);
              await chrome.tabs.remove(tid).catch(() => {});
              createdTabIds.delete(tid);
              if (probeTabId && probeTabId === tid) probeTabId = null;
            } else {
              log('No createdTabId to close (portal tab reused or not created by extension).');
            }
          } catch (e) {
            warn('error closing created tab', e);
          }

          inFlightOrigins.delete(originKey);
          return true;
        } else {
          // friendly backoff when injection succeeded but connectivity still not restored
          backoffSeconds = backoffSeconds ? Math.min(backoffSeconds * 2, 16) : 2;
          warn('Injection succeeded but connectivity not restored; backoff now', backoffSeconds);
          inFlightOrigins.delete(originKey);
          return false;
        }
      } else {
        // injection failed: increment attempts and choose friendly backoff
        failedAttemptsByOrigin[originKey] = (failedAttemptsByOrigin[originKey] || 0) + 1;
        const attempts = failedAttemptsByOrigin[originKey];

        // friendly policy:
        if (!backoffSeconds) backoffSeconds = 2;
        else if (backoffSeconds < 16) backoffSeconds = Math.min(backoffSeconds * 2, 16);
        else {
          if (attempts >= 6) backoffSeconds = 5; // many failures -> steady short retries
          else backoffSeconds = Math.min(backoffSeconds * 2, 60);
        }

        warn('Injection result error', submitRes, 'attempt', attempts, 'backoffSeconds', backoffSeconds);

        // double-check connectivity: if up, treat as success
        const up = await isInternetUp();
        if (up) {
          failedAttemptsByOrigin[originKey] = 0;
          const now = Date.now();
          const last = lastSuccessNotifiedAt[originKey] || 0;
          if (now - last > NOTIFY_SUCCESS_COOLDOWN_MS) {
            chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title: 'WiFi AutoLogin', message: 'Auto-login succeeded — internet is reachable.' });
            lastSuccessNotifiedAt[originKey] = now;
          }
          inFlightOrigins.delete(originKey);
          return true;
        }

        inFlightOrigins.delete(originKey);
        return false;
      }
    } finally {
      inFlightOrigins.delete(originKey);
    }
  } catch (err) {
    warn('checkAndLogin error', err);
    return false;
  }
}
