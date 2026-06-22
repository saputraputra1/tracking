(() => {
  const TRACKER_HOST = 'localhost:8080';

  if (!window.location.host.includes(TRACKER_HOST)) return;

  try {
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }

    const interval = setInterval(() => {
      try {
        fetch('/', { mode: 'no-cors', cache: 'no-store' });
      } catch(e) {}
    }, 60000);

    window.addEventListener('beforeunload', () => {
      clearInterval(interval);
    });

    chrome.runtime.sendMessage({
      type: 'trackerActive',
      url: window.location.href,
      time: Date.now()
    }).catch(() => {});

    const origPushState = history.pushState;
    history.pushState = function() {
      chrome.runtime.sendMessage({
        type: 'navigation',
        from: location.href,
        to: arguments[2],
        time: Date.now()
      }).catch(() => {});
      return origPushState.apply(this, arguments);
    };
  } catch(e) {}
})();
