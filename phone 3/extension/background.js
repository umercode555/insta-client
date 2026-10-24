importScripts('core.js');
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL('dashboard.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs[0]) { chrome.tabs.update(tabs[0].id, { active: true }); chrome.windows.update(tabs[0].windowId, { focused: true }); }
  else chrome.tabs.create({ url });
});
chrome.alarms.create('sync', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'sync') Core.sync(); });
chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  Core.handle(msg).then(send, (e) => send({ ok: false, error: String((e && e.message) || e) }));
  return true;
});
