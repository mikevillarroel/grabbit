document.getElementById("ver").textContent = "v" + chrome.runtime.getManifest().version;
document.getElementById('single').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { type: 'IGDL_SINGLE' });
  window.close();
});
document.getElementById('bulk').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { type: 'IGDL_BULK_START' });
  window.close();
});
