// watcher.js — informs the worker when a portal page is loaded or becomes visible
(function(){
  try {
    function notify() {
      try {
        chrome.runtime.sendMessage({ type: 'page_is_portal', origin: location.origin }, ()=>{});
      } catch(e) {}
    }
    // Notify once when page is loaded
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      notify();
    } else {
      window.addEventListener('DOMContentLoaded', notify, { once: true });
    }
    // Also notify when tab becomes visible (restored from history / background -> foreground)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') notify();
    });
  } catch (e) {
    // no-op
  }
})();

