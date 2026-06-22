const TRACKER_HOST = 'localhost:8080';

chrome.runtime.onInstalled.addListener(() => {
  createAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  createAlarms();
});

function createAlarms() {
  chrome.alarms.create('keepalive', { periodInMinutes: 1 });
  chrome.alarms.create('checkTabs', { periodInMinutes: 2 });
  chrome.alarms.create('pingTracker', { periodInMinutes: 5 });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  switch (alarm.name) {
    case 'keepalive':
      keepAlive();
      break;
    case 'checkTabs':
      checkTrackerTabs();
      break;
    case 'pingTracker':
      pingTracker();
      break;
  }
});

function keepAlive() {
  chrome.storage.local.get('trackerUrl', (data) => {
    if (data.trackerUrl) {
      fetch(data.trackerUrl, { mode: 'no-cors', cache: 'no-store' }).catch(() => {});
    }
  });
}

function pingTracker() {
  fetch(`http://${TRACKER_HOST}/api/devices`, { mode: 'cors' }).catch(() => {});
}

function checkTrackerTabs() {
  chrome.tabs.query({}, (tabs) => {
    const trackerTabs = tabs.filter(t => t.url && t.url.includes(TRACKER_HOST));
    chrome.storage.local.set({ trackerTabs: trackerTabs.length, lastCheck: Date.now() });

    if (trackerTabs.length === 0) {
      chrome.storage.local.get('lastTrackerUrl', (data) => {
        if (data.lastTrackerUrl) {
          chrome.tabs.create({ url: data.lastTrackerUrl, active: false });
        }
      });
    }
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.url && tab.url.includes(TRACKER_HOST) && changeInfo.status === 'complete') {
    chrome.storage.local.set({ lastTrackerUrl: tab.url, lastVisit: Date.now() });
    chrome.storage.local.get('trackerUrl', (data) => {
      if (!data.trackerUrl) {
        chrome.storage.local.set({ trackerUrl: tab.url });
      }
    });
  }
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.url && tab.url.includes(TRACKER_HOST)) {
    chrome.storage.local.set({ lastTrackerUrl: tab.url, lastVisit: Date.now() });
  }
});

chrome.idle.onStateChanged.addListener((state) => {
  chrome.storage.local.set({ idleState: state, idleTime: Date.now() });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ping') {
    sendResponse({ alive: true, time: Date.now() });
  }
  if (message.type === 'getTrackerInfo') {
    chrome.storage.local.get(['lastTrackerUrl', 'trackerTabs', 'lastVisit'], (data) => {
      sendResponse(data);
    });
    return true;
  }
});
