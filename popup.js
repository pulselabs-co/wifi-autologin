// popup.js
function ui(id){ return document.getElementById(id); }

async function sendToWorker(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resp => resolve(resp)));
}

async function saveConfig() {
  const cfg = {
    loginUrl: ui('loginUrl').value.trim() || 'http://172.16.2.1:1000',
    userField: ui('userField').value.trim() || 'username',
    passField: ui('passField').value.trim() || 'password',
    username: ui('username').value,
    password: ui('password').value,
    extraFields: ''
  };
  // cache it in worker
  await sendToWorker({ type:'setPlainConfig', cfg });

  if (ui('remember').checked) {
    // persist to storage forever until cleared
    await new Promise(r => chrome.storage.local.set({ cfg }, r));
    ui('status').innerText = 'Saved and remembered.';
  } else {
    ui('status').innerText = 'Saved (not remembered).';
  }
}

async function testLogin() {
  ui('status').innerText = 'Testing login...';
  const res = await sendToWorker({ type:'doLoginNow' });
  ui('status').innerText = res && res.ok ? 'Test attempted — check connectivity' : 'Test attempted (check console)';
}

async function clearAll() {
  await new Promise(r => chrome.runtime.sendMessage({ type:'clearCache' }, r));
  await new Promise(r => chrome.storage.local.remove(['cfg'], r));
  ui('status').innerText = 'Cleared stored credentials.';
  ui('username').value = '';
  ui('password').value = '';
  ui('remember').checked = false;
}

// mapper on current active tab to detect field names
async function runMapper() {
  ui('status').innerText = 'Running mapper...';
  try {
    const [tab] = await chrome.tabs.query({ active:true, currentWindow:true });
    if (!tab) { ui('status').innerText = 'No active tab.'; return; }
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try {
          const pass = document.querySelector('input[type="password"]');
          const inputs = Array.from(document.querySelectorAll('input'));
          let usernameCandidate = null;
          if (pass) {
            usernameCandidate = inputs.find(i => i !== pass && /user|login|email|name|id/.test((i.name||'') + ' ' + (i.id||'') + ' ' + (i.placeholder||'')));
            if (!usernameCandidate) {
              usernameCandidate = inputs.find(i => i !== pass && (i.type === 'text' || i.type === 'email' || !i.type));
            }
          }
          return { usernameField: usernameCandidate ? (usernameCandidate.name || usernameCandidate.id || '') : '', passwordField: pass ? (pass.name || pass.id || '') : '' };
        } catch(e) { return null; }
      }
    });
    const res = results && results[0] && results[0].result;
    if (res) {
      if (res.usernameField) ui('userField').value = res.usernameField;
      if (res.passwordField) ui('passField').value = res.passwordField;
      ui('status').innerText = `Mapper done. username="${res.usernameField}", password="${res.passwordField}"`;
    } else {
      ui('status').innerText = 'Mapper failed.';
    }
  } catch (e) {
    console.error(e);
    ui('status').innerText = 'Mapper error (see console).';
  }
}

// initialize popup with stored cfg if exists
async function init() {
  ui('status').innerText = 'Initializing...';
  chrome.storage.local.get(['cfg'], (res) => {
    if (res && res.cfg) {
      const cfg = res.cfg;
      ui('loginUrl').value = cfg.loginUrl || 'http://172.16.2.1:1000';
      ui('userField').value = cfg.userField || 'username';
      ui('passField').value = cfg.passField || 'password';
      ui('username').value = cfg.username || '';
      ui('password').value = cfg.password || '';
      ui('remember').checked = true;
      ui('status').innerText = 'Loaded remembered credentials.';
      // tell worker to cache it too
      chrome.runtime.sendMessage({ type:'setPlainConfig', cfg }, resp => {});
    } else {
      ui('status').innerText = 'Ready';
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  ui('saveBtn').addEventListener('click', saveConfig);
  ui('testBtn').addEventListener('click', testLogin);
  ui('clearBtn').addEventListener('click', clearAll);
  ui('mapBtn').addEventListener('click', runMapper);
  init();
});
