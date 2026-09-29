// Grabbit — content script v1.9
(function () {
  'use strict';
  const BTN_CLASS = 'igdl-btn';
  const FAB_ID = 'igdl-fab';
  const VOID_TAGS = /^(IMG|VIDEO|INPUT|BR|HR)$/;
  let bulkMode = false;
  let dlFolder = '';
  let saveAsDlg = false;

  try {
    chrome.storage.sync.get({ dlFolder: '', saveAs: false }, (r) => { dlFolder = ((r && r.dlFolder) || '').replace(/[\\/]+/g, '').trim(); saveAsDlg = !!(r && r.saveAs); });
    chrome.storage.onChanged.addListener((c) => {
      if (c.dlFolder) dlFolder = (c.dlFolder.newValue || '').replace(/[\\/]+/g, '').trim();
      if (c.saveAs) saveAsDlg = !!c.saveAs.newValue;
    });
  } catch (e) {}

  function withFolder(fn) { return dlFolder ? dlFolder + '/' + fn : fn; }

  function bestImgUrl(img) {
    try {
      const srcset = img.getAttribute('srcset');
      if (srcset) {
        let best = null, bestW = 0;
        for (const part of srcset.split(',')) {
          const [url, desc] = part.trim().split(/\s+/);
          const w = parseInt(desc) || 0;
          if (w > bestW && url && url.startsWith('http')) { bestW = w; best = url; }
        }
        if (best) return best;
      }
      const s = img.currentSrc || img.src;
      return (s && s.startsWith('http')) ? s : null;
    } catch (e) { return null; }
  }

  function extFor(url, isVideo) {
    if (isVideo) return 'mp4';
    const m = url.match(/\.([a-z0-9]+)(\?|#|$)/i);
    const e = ((m && m[1]) || 'jpg').toLowerCase();
    return ['jpg','png','webp'].includes(e) ? e : 'jpg';
  }
  function stamp() { return new Date().toISOString().slice(0,19).replace(/[:T]/g,'-'); }
  function username() {
    const m = location.pathname.match(/^\/([a-zA-Z0-9._]+)\/?/);
    return m ? m[1] : 'instagram';
  }

  function findMediaIn(root) {
    try {
      if (!root || !root.querySelectorAll) return null;
      const vids = root.querySelectorAll('video');
      for (const v of vids) {
        const r = v.getBoundingClientRect();
        if (r.width < 150) continue;
        const src = v.currentSrc || v.src;
        if (src && src.startsWith('http')) return { url: src, video: true };
      }
      let best = null, bestArea = 0;
      root.querySelectorAll('img').forEach(img => {
        const r = img.getBoundingClientRect();
        if (r.width < 150 || r.height < 150) return;
        const url = bestImgUrl(img);
        if (!url) return;
        const area = r.width * r.height;
        if (area > bestArea) { bestArea = area; best = url; }
      });
      return best ? { url: best, video: false } : null;
    } catch (e) { return null; }
  }

  function metaMedia() {
    try {
      const ogVS = document.querySelector('meta[property="og:video:secure_url"]');
      if (ogVS && ogVS.content && ogVS.content.startsWith('http')) return { url: ogVS.content, video: true };
      const ogV = document.querySelector('meta[property="og:video"]');
      if (ogV && ogV.content && ogV.content.startsWith('http')) return { url: ogV.content, video: true };
      // og:image on a reel page is just the video thumbnail — never treat it as the media
      if (/^\/reels?\//.test(location.pathname)) return null;
      const ogI = document.querySelector('meta[property="og:image"]');
      if (ogI && ogI.content && ogI.content.startsWith('http')) return { url: ogI.content, video: false };
    } catch (e) {}
    return null;
  }

  // find a <video> with a real downloadable URL (not a blob:)
  function findVideoIn(root) {
    try {
      const vids = root.querySelectorAll('video');
      for (const v of vids) {
        const r = v.getBoundingClientRect();
        if (r.width < 150) continue;
        const src = v.currentSrc || v.src;
        if (src && src.startsWith('http')) return { url: src, video: true };
      }
    } catch (e) {}
    return null;
  }

  function visiblePost() {
    try {
      const cands = document.querySelectorAll('article, main div[role="dialog"]');
      let best = null, bestScore = -1;
      const vy = window.innerHeight / 2;
      cands.forEach(el => {
        const r = el.getBoundingClientRect();
        if (r.height < 200) return;
        const center = r.top + r.height / 2;
        const score = 1 - Math.min(1, Math.abs(center - vy) / window.innerHeight);
        if (score > bestScore) { bestScore = score; best = el; }
      });
      return best;
    } catch (e) { return null; }
  }

  // ask background for the .mp4 it saw Instagram load in this tab
  function getCapturedVideoUrl() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'IGDL_GET_VIDEO_URL' }, (res) => {
          resolve(res && res.url ? res.url : null);
        });
      } catch (e) { resolve(null); }
    });
  }

  // dig the best mp4 out of Instagram's embedded JSON (video_versions array)
  function jsonVideoUrl() {
    try {
      const html = document.documentElement.innerHTML;
      let best = null, bestPx = 0;
      const re = /"video_versions"\s*:\s*\[(.*?)\]/g;
      let vm;
      while ((vm = re.exec(html)) !== null) {
        const ure = /"url"\s*:\s*"(https:[^"]+?)"[^}]*?"width"\s*:\s*(\d+)[^}]*?"height"\s*:\s*(\d+)/g;
        let um;
        while ((um = ure.exec(vm[1])) !== null) {
          const px = (+um[2]) * (+um[3]);
          if (px > bestPx && um[1].indexOf('.mp4') !== -1) {
            bestPx = px;
            best = JSON.parse('"' + um[1] + '"');
          }
        }
        if (!best) {
          const um2 = vm[1].match(/"url"\s*:\s*"(https:[^"]+\.mp4[^"]*)"/);
          if (um2) best = JSON.parse('"' + um2[1] + '"');
        }
      }
      if (best) return { url: best, video: true };
      const m = html.match(/"video_url"\s*:\s*"(https:[^"]+\.mp4[^"]*)"/);
      if (m) return { url: JSON.parse('"' + m[1] + '"'), video: true };
    } catch (e) {}
    return null;
  }
  // parse Instagram's carousel_media JSON -> [{url, video}] (best quality each)
  function getCarouselMedia() {
    try {
      const html = document.documentElement.innerHTML;
      const marker = '"carousel_media"';
      const idx = html.indexOf(marker);
      if (idx === -1) return null;
      const arrStart = html.indexOf('[', idx + marker.length);
      if (arrStart === -1) return null;
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = arrStart; i < html.length; i++) {
        const ch = html[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
        } else {
          if (ch === '"') inStr = true;
          else if (ch === '[') depth++;
          else if (ch === ']') { depth--; if (depth === 0) { end = i; break; } }
        }
      }
      if (end === -1) return null;
      const arr = JSON.parse(html.slice(arrStart, end + 1));
      const items = [];
      for (const item of arr) {
        if (item.video_versions && item.video_versions.length) {
          let best = null, bestPx = 0;
          for (const v of item.video_versions) {
            const px = (v.width || 0) * (v.height || 0);
            if (v.url && v.url.indexOf('.mp4') !== -1 && px > bestPx) { bestPx = px; best = v.url; }
          }
          if (best) items.push({ url: best, video: true });
        } else if (item.image_versions2 && item.image_versions2.candidates) {
          let best = null, bestW = 0;
          for (const c of item.image_versions2.candidates) {
            if (c.url && (c.width || 0) > bestW) { bestW = c.width; best = c.url; }
          }
          if (best) items.push({ url: best, video: false });
        }
      }
      return items.length ? items : null;
    } catch (e) { return null; }
  }

  // download several items with numbered filenames
  async function downloadAll(items, label) {
    const folder = dlFolder ? dlFolder + '/' : '';
    let i = 0;
    for (const item of items) {
      i++;
      const ext = item.video ? 'mp4' : extFor(item.url, false);
      const fn = folder + 'igdl_' + label + '_' + stamp() + '_' + i + '.' + ext;
      try { chrome.runtime.sendMessage({ type: 'IGDL_DOWNLOAD', url: item.url, filename: fn, saveAs: false }); } catch (e) {}
      await new Promise(r => setTimeout(r, 400));
    }
  }


  // ---------- YouTube ----------
  // ---------- TikTok ----------
  function tiktokVideoUrl() {
    try {
      // 1) direct src on the video element (TikTok often uses real URLs, not blob)
      const vids = document.querySelectorAll('video');
      for (const v of vids) {
        const r = v.getBoundingClientRect();
        if (r.width < 200) continue;
        const src = v.currentSrc || v.src;
        if (src && src.indexOf('http') === 0 && src.indexOf('blob:') !== 0) {
          return { url: src, video: true, tt: true };
        }
      }
      // 2) embedded JSON playAddr/downloadAddr
      const html = document.documentElement.innerHTML;
      const m = html.match(/"(?:playAddr|downloadAddr)"\s*:\s*"(https:[^"]+)"/);
      if (m) return { url: JSON.parse('"' + m[1] + '"'), video: true, tt: true };
      // 3) any tiktokcdn mp4 in the HTML
      const m2 = html.match(/"(https:[^"]*tiktokcdn[^"]*\.mp4[^"]*)"/);
      if (m2) return { url: JSON.parse('"' + m2[1] + '"'), video: true, tt: true };
    } catch (e) {}
    return null;
  }

  async function findBestMedia() {
    try {
      if (/tiktok\.com$/.test(location.hostname)) {
        // captured mp4 off the network first (most reliable), then DOM/JSON
        const cap = await getCapturedVideoUrl();
        if (cap) return { url: cap, video: true, tt: true };
        const tt = tiktokVideoUrl();
        if (tt) return tt;
        return null;
      }
      if (/facebook\.com$/.test(location.hostname) || /threads\.com$/.test(location.hostname)) {
        const prefix = /facebook/.test(location.hostname) ? 'facebook' : 'threads';
        // Meta platforms: captured mp4 first, then video element / JSON / og:video
        const cap = await getCapturedVideoUrl();
        if (cap) return { url: cap, video: true, fbPrefix: prefix };
        // Try video element src (not just currentSrc — src may be progressive while currentSrc is blob)
        const vids = document.querySelectorAll('video');
        for (const v of vids) {
          const r = v.getBoundingClientRect();
          if (r.width < 200) continue;
          const sources = [v.src, v.currentSrc];
          v.querySelectorAll('source').forEach(s => sources.push(s.src));
          for (const src of sources) {
            if (src && src.indexOf('http') === 0 && src.indexOf('blob:') !== 0) {
              return { url: src, video: true, fbPrefix: prefix };
            }
          }
        }
        // Facebook embeds playable_url in JSON; Threads uses video_versions like IG
        try {
          const html = document.documentElement.innerHTML;
          // More lenient: playable_url may be escaped or in different format
          let pm = html.match(/"playable_url_quality_hd"\s*:\s*"([^"]+)"/) || html.match(/"playable_url"\s*:\s*"([^"]+)"/);
          if (!pm) pm = html.match(/playable_url[^"]*"([^"]*fbcdn[^"]*)"/);
          if (pm) return { url: JSON.parse('"' + pm[1] + '"'), video: true, fbPrefix: prefix };
          // Any fbcdn video URL in the HTML
          const fbm = html.match(/"(https:[^"]*fbcdn[^"]*video[^"]*)"/i);
          if (fbm) {
            try { return { url: JSON.parse('"' + fbm[1] + '"'), video: true, fbPrefix: prefix }; } catch (e) {}
          }
          const vm = html.match(/"video_versions"\s*:\s*\[([^\]]+)\]/);
          if (vm) {
            const um = vm[1].match(/"url"\s*:\s*"([^"]+\.mp4[^"]*)"/g);
            if (um && um.length) {
              const last = um[um.length - 1].match(/"url"\s*:\s*"([^"]+)"/);
              if (last) return { url: JSON.parse('"' + last[1] + '"'), video: true, fbPrefix: prefix };
            }
          }
        } catch (e) {}
        const ogv = document.querySelector('meta[property="og:video"], meta[property="og:video:secure_url"]');
        if (ogv && ogv.content) {
          return { url: ogv.content, video: true, fbPrefix: prefix };
        }
        return null;
      }
      const isDirect = /^\/(p|reel|reels|stories)\//.test(location.pathname);
      const visPost = visiblePost();
      const visHasVideo = !!(visPost && visPost.querySelector('video'));
      const tryVideo = isDirect || visHasVideo;
      if (tryVideo) {
        const m = metaMedia();
        // take meta video, but never a thumbnail when the page might be video
        if (m && m.video) return m;
      }
      if (tryVideo) {
        // 1) the real .mp4 captured off the network (beats blob: URLs)
        const cap = await getCapturedVideoUrl();
        if (cap) return { url: cap, video: true };
        // 2) embedded JSON video_versions
        const jv = jsonVideoUrl();
        if (jv) return jv;
        // 3) the playing <video> element's file
        const v = findVideoIn(document);
        if (v) return v;
      }
      if (isDirect) {
        const mi = metaMedia();
        if (mi) return mi;
      }
      const post = visiblePost();
      let m = post && findMediaIn(post);
      if (m) return m;
      const main = document.querySelector('main');
      m = main && findMediaIn(main);
      if (m) return m;
      m = metaMedia();
      if (m) return m;
      return findMediaIn(document.body);
    } catch (e) { return null; }
  }

  async function doDownload(mediaOrPromise) {
    const media = await mediaOrPromise;
    if (!media) { alert('No media found.'); return; }
    let base = `igdl_${username()}_${stamp()}_${Math.floor(Math.random()*1e4)}`;
    let ext = extFor(media.url, media.video);
    if (media.fbPrefix) {
      base = media.fbPrefix + '_' + stamp();
      ext = 'mp4';
    }
    if (media.tt) {
      const um = location.pathname.match(/\/video\/(\d+)/);
      base = 'tiktok_' + (um ? um[1] : stamp());
      ext = 'mp4';
      // Run the fetch in the page's main world via the scripting API
      // (bypasses TikTok's CSP which blocks inline scripts; page context
      // gives the request the right origin/referer/cookies).
      chrome.runtime.sendMessage({ type: 'IGDL_PAGE_DL', url: media.url, filename: withFolder(base + '.' + ext) });
      return;
    }
    const fn = withFolder(`${base}.${ext}`);
    try {
      chrome.runtime.sendMessage({ type: 'IGDL_DOWNLOAD', url: media.url, filename: fn, saveAs: saveAsDlg }, (resp) => {
        if (resp && !resp.ok) alert('Download failed: ' + (resp.error || 'unknown error'));
      });
    }
    catch (e) { alert('Download failed: extension context lost. Reload the page.'); }
  }

  function styleBtn(btn, big) {
    const s = big ? 52 : 38;
    Object.assign(btn.style, {
      position: big ? 'fixed' : 'absolute',
      width: s+'px', height: s+'px', borderRadius: '50%', border: '2px solid rgba(255,255,255,.85)',
      background: '#0095f6', color: '#fff', fontSize: big ? '24px' : '18px',
      cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 2px 10px rgba(0,0,0,.4)', zIndex: 2147483647
    });
    if (big) { btn.style.bottom = '24px'; btn.style.right = '24px'; }
    else { btn.style.top = '10px'; btn.style.right = '10px'; }
  }

  // climb from a media element to a container that can hold a button
  function buttonHost(el) {
    let node = el;
    for (let i = 0; i < 6 && node; i++) {
      if (!VOID_TAGS.test(node.tagName) && node !== document.body && node !== document.documentElement) {
        // prefer a wrapper close to the media's own size
        const r = node.getBoundingClientRect();
        const mr = el.getBoundingClientRect();
        if (r.width < mr.width * 2.5 && r.height < mr.height * 2.5) return node;
      }
      node = node.parentElement;
    }
    return el.parentElement;
  }

  function addButton(container) {
    try {
      if (!container || VOID_TAGS.test(container.tagName)) return;
      if (container.querySelector(':scope > .' + BTN_CLASS)) return;
      const btn = document.createElement('button');
      btn.className = BTN_CLASS;
      btn.textContent = '⬇'; btn.title = 'Download media';
      styleBtn(btn, false);
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        // carousel on a direct post page? grab every slide
        if (/^\/p\//.test(location.pathname)) {
          const car = getCarouselMedia();
          if (car && car.length > 1) {
            downloadAll(car, username() + '_carousel');
            btn.textContent = '✓'; setTimeout(() => btn.textContent = '⬇', 1500);
            return;
          }
        }
        // Facebook/Threads/TikTok: always use the smart finder (their DOM isn't Instagram's)
        if (/facebook\.com$/.test(location.hostname) || /threads\.com$/.test(location.hostname) || /tiktok\.com$/.test(location.hostname)) {
          doDownload(findBestMedia());
        } else {
          // video in this container? use the smart finder (captured mp4 / video_versions),
          // since Instagram plays video via blob: URLs the container scan can't see.
          // photo-only container: the container's own media is correct.
          const hasVideo = !!container.querySelector('video');
          doDownload(hasVideo ? findBestMedia() : (findMediaIn(container) || findBestMedia()));
        }
        btn.textContent = '✓'; setTimeout(() => btn.textContent = '⬇', 1500);
      });
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
      container.appendChild(btn);
    } catch (e) { /* never let one button kill the scan */ }
  }

  function ensureFab() {
    try {
      if (document.getElementById(FAB_ID)) return;
      const fab = document.createElement('button');
      fab.id = FAB_ID; fab.textContent = '⬇'; fab.title = 'Download visible post';
      styleBtn(fab, true);
      fab.addEventListener('click', (e) => {
        e.stopPropagation();
        if (/^\/p\//.test(location.pathname)) {
          const car = getCarouselMedia();
          if (car && car.length > 1) {
            downloadAll(car, username() + '_carousel');
            fab.textContent = '✓'; setTimeout(() => fab.textContent = '⬇', 1500);
            return;
          }
        }
        doDownload(findBestMedia());
        fab.textContent = '✓'; setTimeout(() => fab.textContent = '⬇', 1500);
      });
      (document.body || document.documentElement).appendChild(fab);
    } catch (e) {}
  }

  function scan() {
    try {
      // TikTok video page: pin a button on the player
      if (/tiktok\.com$/.test(location.hostname) && location.pathname.indexOf('/video/') !== -1) {
        let target = null, bestArea = 0;
        document.querySelectorAll('video').forEach(el => {
          const r = el.getBoundingClientRect();
          if (r.width < 200 || r.height < 200) return;
          const area = r.width * r.height;
          if (area > bestArea) { bestArea = area; target = el; }
        });
        if (target) addButton(buttonHost(target));
        return;
      }
      // Facebook / Threads: rely on the floating button (their React trees wipe injected buttons).
      // Just ensure the FAB exists; don't pin per-post buttons.
      if (/facebook\.com$/.test(location.hostname) || /threads\.com$/.test(location.hostname)) {
        return;
      }
      // direct post / reel view: pin a button on the main media's wrapper
      if (/^\/(p|reel|reels)\//.test(location.pathname)) {
        const main = document.querySelector('main');
        if (main) {
          let target = null, bestArea = 0;
          main.querySelectorAll('video, img').forEach(el => {
            const r = el.getBoundingClientRect();
            if (r.width < 200 || r.height < 200) return;
            const area = r.width * r.height;
            if (area > bestArea) { bestArea = area; target = el; }
          });
          if (target) addButton(buttonHost(target));
        }
      }
      // stories viewer: pin a button on the current story media
      if (/^\/stories\//.test(location.pathname)) {
        const viewer = document.querySelector('div[role="dialog"]') || document.querySelector('main');
        if (viewer) {
          let target = null, bestArea = 0;
          viewer.querySelectorAll('video, img').forEach(el => {
            const r = el.getBoundingClientRect();
            if (r.width < 200 || r.height < 200) return;
            if (el.tagName === 'IMG') {
              const src = el.currentSrc || el.src || '';
              if (src.includes('profile_pic') || src.includes('s150x150')) return;
            }
            const area = r.width * r.height;
            if (area > bestArea) { bestArea = area; target = el; }
          });
          if (target) addButton(buttonHost(target));
        }
      }
      document.querySelectorAll('article').forEach(addButton);
      document.querySelectorAll('a[href^="/p/"], a[href^="/reel/"], a[href*="/p/"], a[href*="/reel/"]').forEach(a => {
        if (a.querySelector('img, video')) addButton(a);
      });
      document.querySelectorAll('div[role="dialog"]').forEach(addButton);
    } catch (e) {}
    ensureFab(); // always last, always runs
  }

  function collectAll() {
    const seen = new Set(), items = [];
    try {
      const push = (url, video) => {
        if (!url || !url.startsWith('http') || seen.has(url)) return;
        seen.add(url);
        items.push({ url, filename: withFolder(`igdl_${username()}_bulk_${stamp()}_${items.length}.${extFor(url, video)}`) });
      };
      document.querySelectorAll('img').forEach(img => {
        const r = img.getBoundingClientRect();
        if (r.width < 150) return;
        push(bestImgUrl(img), false);
      });
      document.querySelectorAll('video').forEach(v => {
        const r = v.getBoundingClientRect();
        if (r.width < 150) return;
        push(v.currentSrc || v.src, true);
      });
    } catch (e) {}
    return items;
  }

  async function bulkDownload() {
    if (bulkMode) return; bulkMode = true;
    try {
      let lastH = 0, tries = 0;
      while (tries < 12) {
        window.scrollTo(0, document.body.scrollHeight);
        await new Promise(r => setTimeout(r, 1200));
        const h = document.body.scrollHeight;
        if (h === lastH) tries++; else tries = 0;
        lastH = h;
      }
      window.scrollTo(0, 0);
      const items = collectAll();
      if (!items.length) { alert('No media found on this page.'); return; }
      if (!confirm(`Download ${items.length} files from @${username()}?`)) return;
      chrome.runtime.sendMessage({ type: 'IGDL_BULK', items, saveAs: false }, (res) => {
        alert(res ? `Downloaded ${res.ok}/${res.total}` : 'Download started');
      });
    } catch (e) { alert('Bulk download failed. Reload the page and try again.'); }
    finally { bulkMode = false; }
  }

  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'IGDL_SCAN') scan();
      if (msg.type === 'IGDL_BULK_START') bulkDownload();
      if (msg.type === 'IGDL_SINGLE') doDownload(findBestMedia());
    });
  } catch (e) {}

  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      try { chrome.runtime.sendMessage({ type: 'IGDL_CLEAR_VIDEO' }); } catch (e) {}
    }
  }, 1000);
  ensureFab();
  scan();
  try {
    const obs = new MutationObserver(() => scan());
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  setInterval(() => { try { scan(); } catch (e) {} }, 2500);
})();
