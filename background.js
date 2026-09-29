// IG Media Downloader — background service worker
// Receives download requests from the content script and saves files.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'IGDL_CLEAR_VIDEO') {
    if (sender.tab) delete tabVideos[sender.tab.id];
    sendResponse({ ok: true });
    return true;
  }
  if (msg.type === 'IGDL_GET_VIDEO_URL') {
    const arr = (sender.tab && tabVideos[sender.tab.id]) || [];
    // .mp4 URLs first, then Facebook video CDN URLs (which often lack .mp4)
    const mp4s = arr.filter(e => /\.mp4(\?|#|$)/i.test(e.url));
    if (mp4s.length) {
      sendResponse({ url: mp4s[mp4s.length - 1].url });
    } else {
      const fbvids = arr.filter(e => /video.*\.fbcdn\.net/i.test(e.url) || (/fbcdn\.net/i.test(e.url) && /video/i.test(e.url)));
      sendResponse({ url: fbvids.length ? fbvids[fbvids.length - 1].url : null });
    }
    return true;
  }
  if (msg.type === 'IGDL_PAGE_DL') {
    (async () => {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: sender.tab.id },
          world: 'MAIN',
          func: (videoUrl, filename) => {
            fetch(videoUrl)
              .then(r => { if (!r.ok) throw new Error('Request failed: ' + r.status); return r.blob(); })
              .then(blob => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = filename;
                document.body.appendChild(a); a.click();
                setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 60000);
              })
              .catch(e => alert('Download failed: ' + e.message));
          },
          args: [msg.url, msg.filename]
        });
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: String(e) }); }
    })();
    return true;
  }
  if (msg.type === 'IGDL_DOWNLOAD_BLOB') {
    (async () => {
      try {
        const blobUrl = URL.createObjectURL(msg.blob);
        try {
          await chrome.downloads.download({ url: blobUrl, filename: msg.filename, saveAs: !!msg.saveAs });
          sendResponse({ ok: true });
        } finally {
          setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
        }
      } catch (e) { sendResponse({ ok: false, error: String(e) }); }
    })();
    return true;
  }
  if (msg.type === 'IGDL_DOWNLOAD') {
    downloadOne(msg.url, msg.filename, msg.saveAs).then(sendResponse);
    return true; // async
  }
  if (msg.type === 'IGDL_BULK') {
    (async () => {
      let ok = 0;
      for (let i = 0; i < msg.items.length; i++) {
        const it = msg.items[i];
        try {
          await downloadOne(it.url, it.filename, msg.saveAs);
          ok++;
        } catch (e) { /* skip failures */ }
        // small delay so Instagram doesn't throttle
        await new Promise(r => setTimeout(r, 300));
      }
      sendResponse({ ok, total: msg.items.length });
    })();
    return true;
  }
});

async function downloadOne(url, filename, saveAs) {
  try {
    // YouTube's googlevideo URLs often fail via chrome.downloads directly
    // (auth/headers) — fetch the bytes first, then download as a blob.
    if (url.includes('googlevideo.com')) {
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) throw new Error('YouTube request failed: ' + resp.status);
      const blob = await resp.blob();
      const blobUrl = URL.createObjectURL(new Blob([blob], { type: 'video/mp4' }));
      try {
        await chrome.downloads.download({ url: blobUrl, filename, saveAs: !!saveAs });
      } finally {
        setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
      }
      return { ok: true };
    }
    await chrome.downloads.download({ url, filename, saveAs: !!saveAs });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// Auto-inject content script into already-open Instagram tabs on install/update,
// so the user doesn't have to manually reload the tab.
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: ['https://www.instagram.com/*', 'https://www.tiktok.com/*', 'https://www.facebook.com/*', 'https://www.threads.com/*'] });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
      } catch (e) {}
    }
  } catch (e) {}
});

// Capture direct .mp4 URLs as Instagram loads them, keyed by tab.
// Instagram plays video through blob: URLs, so the real file URL is only
// visible on the network — we grab it here for later download requests.
const tabVideos = {};
try {
  chrome.webRequest.onCompleted.addListener(
    (d) => {
      if (d.tabId < 0) return;
      const arr = tabVideos[d.tabId] || (tabVideos[d.tabId] = []);
      arr.push({ url: d.url, t: Date.now() });
      if (arr.length > 20) arr.shift();
    },
    { urls: ['*://*.cdninstagram.com/*', '*://*.fbcdn.net/*', '*://*.instagram.com/*', '*://*.tiktokcdn.com/*', '*://*.tiktokv.com/*'] },
    []
  );
  chrome.tabs.onRemoved.addListener((id) => { delete tabVideos[id]; });
} catch (e) {}
