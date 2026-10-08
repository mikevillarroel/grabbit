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
      let done = false;
      const finish = (url) => { if (!done) { done = true; resolve(url); } };
      // Timeout: never hang the download waiting for background
      setTimeout(() => finish(null), 3000);
      try {
        chrome.runtime.sendMessage({ type: 'IGDL_GET_VIDEO_URL' }, (res) => {
          finish(res && res.url ? res.url : null);
        });
      } catch (e) { finish(null); }
    });
  }

  // dig the best mp4 out of Instagram's embedded JSON (video_versions array)
  function jsonVideoUrl() {
    try {
      // Read from script textContent (raw) — innerHTML escapes quotes
      let html = null;
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const t = s.textContent || '';
        if (t.indexOf('video_versions') !== -1) { html = t; break; }
      }
      if (!html) {
        html = document.documentElement.innerHTML
          .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      }
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
  // Get carousel data via Instagram's GraphQL API (PolarisPostRootQuery).
  // This is the reliable method used by mature downloaders — Instagram's
  // own API returns the full carousel_media array with all slides.
  // Returns {items} on success, {error} on failure for diagnostics.
  async function getCarouselViaGraphQL(shortcode) {
    try {
      if (!shortcode) return { error: 'no shortcode' };

      // Get CSRF token from cookies
      function getCookie(name) {
        const m = document.cookie.match(new RegExp('(^|;\\s*)' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[2]) : '';
      }
      // Get fb_dtsg token from page scripts
      function getFbDtsg() {
        for (const script of document.scripts) {
          const text = script.textContent || '';
          const m = text.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) ||
                    text.match(/"dtsg":\s*\{\s*"token":"([^"]+)"/);
          if (m) return m[1];
        }
        return '';
      }

      const fbDtsg = getFbDtsg();
      const csrfToken = getCookie('csrftoken');
      if (!fbDtsg) return { error: 'no fb_dtsg token (scripts: ' + document.scripts.length + ')' };
      if (!csrfToken) return { error: 'no csrftoken cookie' };

      const params = new URLSearchParams({
        fb_dtsg: fbDtsg,
        fb_api_caller_class: 'RelayModern',
        fb_api_req_friendly_name: 'PolarisPostRootQuery',
        doc_id: '27852811784380813',
        variables: JSON.stringify({ shortcode }),
        server_timestamps: 'true',
      });

      const resp = await fetch('https://www.instagram.com/graphql/query', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-fb-friendly-name': 'PolarisPostRootQuery',
          'x-csrftoken': csrfToken,
          'x-ig-app-id': '936619743392459',
          'x-requested-with': 'XMLHttpRequest',
        },
        body: params.toString(),
        credentials: 'include',
        referrer: window.location.href,
      });

      if (!resp.ok) return { error: 'HTTP ' + resp.status };
      const json = await resp.json();
      if (json.errors) return { error: 'GraphQL errors: ' + JSON.stringify(json.errors).slice(0, 200) };
      const item = json?.data?.['xdt_api__v1__media__shortcode__web_info']?.items?.[0];
      if (!item) return { error: 'no item in response (keys: ' + Object.keys(json?.data || {}).join(',') + ')' };

      const items = [];
      const carousel = item['carousel_media'];
      if (!carousel) return { error: 'no carousel_media (single post?)' };
      for (const slide of carousel) {
        const isVideo = slide['media_type'] !== 1;
        let url = null;
        if (isVideo && slide['video_versions'] && slide['video_versions'].length) {
          url = slide['video_versions'][0]['url'];
        } else if (slide['image_versions2'] && slide['image_versions2']['candidates'] &&
                   slide['image_versions2']['candidates'].length) {
          url = slide['image_versions2']['candidates'][0]['url'];
        }
        if (url) items.push({ url, video: isVideo });
      }
      if (items.length <= 1) return { error: 'only ' + items.length + ' items parsed' };
      return { items };
    } catch (e) { return { error: 'exception: ' + e.message }; }
  }

  // Fetch each carousel slide directly via ?img_index=N deep links.
  // Instagram serves the Nth slide's image as the page's primary image.
  // No button-finding or DOM navigation needed.
  async function getCarouselViaImgIndex() {
    try {
      const baseUrl = location.origin + location.pathname;
      const seen = new Set();
      const items = [];

      // How many slides? Check pagination dots first, else probe up to 10.
      let total = document.querySelectorAll('._acnb').length;
      if (!total) total = 10; // probe blind

      for (let i = 0; i < total; i++) {
        try {
          const resp = await fetch(baseUrl + '?img_index=' + i, { credentials: 'include' });
          if (!resp.ok) break;
          const html = await resp.text();
          // The slide's image: og:image meta tag
          const m = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
          if (m && m[1].indexOf('http') === 0 && !seen.has(m[1])) {
            seen.add(m[1]);
            items.push({ url: m[1], video: false });
          } else if (i > 0 && items.length === 0) {
            break; // no image and we haven't found any — not a carousel
          }
          // Small delay to avoid rate limiting
          await new Promise(r => setTimeout(r, 300));
        } catch (e) { break; }
        // Stop if we've found slides and the count matches dots
        if (total <= 10 && document.querySelectorAll('._acnb').length > 0 &&
            items.length >= document.querySelectorAll('._acnb').length) break;
      }

      return items.length > 1 ? items : null;
    } catch (e) { return null; }
  }

  // Navigate through carousel slides, capturing each slide's media.
  // This works regardless of Instagram's JSON structure since it reads
  // each slide as it becomes visible, like a user flipping through.
  async function getCarouselViaNavigation() {
    try {
      const seen = new Set();
      const items = [];

      // Dispatch a REAL mouse click (React sometimes ignores .click())
      function realClick(el) {
        try {
          const r = el.getBoundingClientRect();
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          for (const type of ['mousedown', 'mouseup', 'click']) {
            el.dispatchEvent(new MouseEvent(type, {
              bubbles: true, cancelable: true, view: window, clientX: x, clientY: y
            }));
          }
        } catch (e) { try { el.click(); } catch (e2) {} }
      }

      // Find carousel nav buttons using multiple strategies —
      // Instagram has at least two carousel layouts with different markup.
      function findNavBtn(dir) {
        const wantNext = dir === 'next';
        // Strategy 1: aria-label (various casings and phrasings)
        const labels = wantNext
          ? ['next', 'siguiente']
          : ['previous', 'back', 'anterior', 'atrás'];
        const btns = document.querySelectorAll('button');
        for (const b of btns) {
          if (b.offsetParent === null || b.disabled) continue;
          const label = (b.getAttribute('aria-label') || '').toLowerCase().trim();
          if (labels.includes(label)) return b;
        }
        // Strategy 2: chevron SVG inside button (carousel arrows use chevrons)
        for (const b of btns) {
          if (b.offsetParent === null || b.disabled) continue;
          const svg = b.querySelector('svg');
          if (!svg) continue;
          const svgLabel = ((svg.getAttribute('aria-label') || '') + ' ' +
            (b.innerHTML || '')).toLowerCase();
          // chevron pointing right = next, left = previous
          const isChevron = /chevron/i.test(svgLabel) || /polygon|polyline/.test(b.innerHTML);
          if (!isChevron) continue;
          // Determine direction by transform or path data is unreliable;
          // use button position relative to post center instead
          const post = visiblePost() || document.querySelector('main');
          if (post) {
            const pr = post.getBoundingClientRect();
            const br = b.getBoundingClientRect();
            const centerX = pr.left + pr.width / 2;
            const isRight = br.left > centerX;
            if (wantNext === isRight && br.width < 80 && br.height < 80) return b;
          }
        }
        // Strategy 3: CSS-drawn chevron (div with no SVG, e.g. class _9zm2)
        // Carousel nav buttons are small (~30-45px) circular buttons
        // flanking the left/right edges of the media area
        const post = visiblePost() || document.querySelector('main');
        if (post) {
          const pr = post.getBoundingClientRect();
          const centerX = pr.left + pr.width / 2;
          for (const b of btns) {
            if (b.offsetParent === null || b.disabled) continue;
            const br = b.getBoundingClientRect();
            if (br.width < 20 || br.width > 70 || br.height < 20 || br.height > 70) continue;
            // Must be vertically centered on the media, horizontally offset
            const vertCenter = br.top + br.height / 2;
            const postVertCenter = pr.top + pr.height / 2;
            if (Math.abs(vertCenter - postVertCenter) > pr.height * 0.3) continue;
            const isRight = br.left > centerX;
            if (wantNext !== isRight) continue;
            // Must be near the media edge (not random UI buttons)
            const distFromEdge = wantNext
              ? Math.abs((pr.left + pr.width) - br.left)
              : Math.abs(br.left - pr.left);
            if (distFromEdge < pr.width * 0.25) return b;
          }
        }
        return null;
      }
      function findNextBtn() { return findNavBtn('next'); }
      function findPrevBtn() { return findNavBtn('prev'); }

      // Get current slide index from pagination dots (active dot has _acnf class)
      function getActiveDotIndex() {
        const dots = document.querySelectorAll('._acnb');
        for (let i = 0; i < dots.length; i++) {
          if (dots[i].classList.contains('_acnf')) return i;
        }
        return -1;
      }
      function countDots() {
        return document.querySelectorAll('._acnb').length;
      }

      // Not a carousel if there's no Next button and only 0-1 dots
      const initialDots = countDots();
      if (!findNextBtn() && initialDots <= 1) return null;

      // Rewind to the first slide
      let guard = 0;
      let prev = findPrevBtn();
      while (prev && guard < 10) {
        realClick(prev);
        await new Promise(r => setTimeout(r, 700));
        guard++;
        prev = findPrevBtn();
      }

      // Walk forward, capturing each slide.
      // Use dot changes to confirm navigation actually worked.
      const totalSlides = Math.max(countDots(), 2);
      guard = 0;
      let lastDotIndex = getActiveDotIndex();
      while (guard < totalSlides + 2) {
        await new Promise(r => setTimeout(r, 1000)); // let slide load

        // Grab the currently displayed slide's media:
        // the largest visible image/video in the post area
        const post = visiblePost() || document.querySelector('main');
        let best = null, bestArea = 0;
        if (post) {
          post.querySelectorAll('img').forEach(img => {
            const r = img.getBoundingClientRect();
            // Current slide fills the viewport area; must be actually visible
            if (r.width < 200 || r.height < 200) return;
            if (r.top < -r.height / 2 || r.top > window.innerHeight) return;
            const src = img.currentSrc || img.src || '';
            if (!src.startsWith('http') || /profile_pic|s150x150/.test(src)) return;
            const url = bestImgUrl(img);
            if (!url || seen.has(url)) return;
            const area = r.width * r.height;
            if (area > bestArea) { bestArea = area; best = { url, video: false }; }
          });
          post.querySelectorAll('video').forEach(v => {
            const r = v.getBoundingClientRect();
            if (r.width < 200 || r.height < 200) return;
            if (r.top < -r.height / 2 || r.top > window.innerHeight) return;
            const src = v.currentSrc || v.src;
            if (src && src.startsWith('http') && src.indexOf('blob:') !== 0 && !seen.has(src)) {
              const area = r.width * r.height;
              if (area > bestArea) { bestArea = area; best = { url: src, video: true }; }
            }
          });
        }
        if (best) { seen.add(best.url); items.push(best); }

        const next = findNextBtn();
        if (!next) break; // reached the last slide (no Next button)

        const dotBefore = getActiveDotIndex();
        realClick(next);
        // Wait for the dot to change (confirms slide advanced)
        let waited = 0;
        while (waited < 3000) {
          await new Promise(r => setTimeout(r, 300));
          waited += 300;
          if (getActiveDotIndex() !== dotBefore && getActiveDotIndex() !== -1) break;
        }
        guard++;

        // Safety: if we've collected as many as there are dots, stop
        if (initialDots > 1 && items.length >= initialDots) break;
      }

      // Strategy 4 fallback: if we only got 1 slide but dots show multiple,
      // try keyboard navigation (some layouts respond to arrow keys)
      if (items.length <= 1 && initialDots > 1) {
        const post = visiblePost() || document.querySelector('main');
        if (post) {
          try { post.focus(); } catch (e) {}
          // Rewind with Left arrows
          for (let i = 0; i < 10; i++) {
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'ArrowLeft', bubbles: true, cancelable: true
            }));
            await new Promise(r => setTimeout(r, 500));
          }
          // Walk forward with Right arrows
          for (let i = 0; i < initialDots; i++) {
            await new Promise(r => setTimeout(r, 900));
            let best = null, bestArea = 0;
            post.querySelectorAll('img').forEach(img => {
              const r = img.getBoundingClientRect();
              if (r.width < 200 || r.height < 200) return;
              const src = img.currentSrc || img.src || '';
              if (!src.startsWith('http') || /profile_pic|s150x150/.test(src)) return;
              const url = bestImgUrl(img);
              if (!url || seen.has(url)) return;
              const area = r.width * r.height;
              if (area > bestArea) { bestArea = area; best = { url, video: false }; }
            });
            if (best) { seen.add(best.url); items.push(best); }
            document.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'ArrowRight', bubbles: true, cancelable: true
            }));
          }
        }
      }

      return items.length > 1 ? items : null;
    } catch (e) { return null; }
  }

  // Diagnostic: reports what's on the page when download fails.
  // Shows an alert with details so the user can report back.
  function diagnosePage(gqlError) {
    try {
      const lines = ['Grabbit diagnostic:'];
      lines.push('URL: ' + location.pathname);
      if (gqlError) lines.push('GraphQL error: ' + gqlError);
      // Buttons
      const allBtns = document.querySelectorAll('button');
      lines.push('Total buttons: ' + allBtns.length);
      const labeled = [];
      allBtns.forEach(b => {
        const al = b.getAttribute('aria-label');
        if (al && /next|prev|previous/i.test(al)) labeled.push(al + ' (offsetParent=' + (b.offsetParent !== null) + ')');
      });
      lines.push('Nav buttons: ' + (labeled.join(', ') || 'NONE FOUND'));
      // Dots
      const dots = document.querySelectorAll('._acnb');
      lines.push('Pagination dots (_acnb): ' + dots.length);
      // Images
      const imgs = document.querySelectorAll('img');
      let bigImgs = 0;
      imgs.forEach(img => {
        const r = img.getBoundingClientRect();
        if (r.width >= 200 && r.height >= 200) bigImgs++;
      });
      lines.push('Images total: ' + imgs.length + ', large (200px+): ' + bigImgs);
      // Videos
      const vids = document.querySelectorAll('video');
      lines.push('Videos: ' + vids.length);
      // Articles
      lines.push('Articles: ' + document.querySelectorAll('article').length);
      // Our buttons
      lines.push('Our ⬇ buttons: ' + document.querySelectorAll('.' + BTN_CLASS).length);
      lines.push('Our hover buttons: ' + document.querySelectorAll('.igdl-hover-btn').length);
      // JSON
      const html = document.documentElement.innerHTML;
      lines.push('Has carousel_media JSON: ' + (html.indexOf('carousel_media') !== -1));
      alert(lines.join('\n'));
    } catch (e) { alert('Diagnostic failed: ' + e.message); }
  }
  // not just the visible one. Works regardless of Instagram's JSON structure.
  function getCarouselMediaFromDOM(root) {
    try {
      const container = root || visiblePost() || document.querySelector('main');
      if (!container) return null;
      const seen = new Set();
      const items = [];

      // Collect all content images (skip UI chrome, profile pics, thumbnails)
      container.querySelectorAll('img').forEach(img => {
        try {
          const src = img.currentSrc || img.src || '';
          if (!src || src.indexOf('http') !== 0) return;
          if (/profile_pic|s150x150|s320x320|emoji/.test(src)) return;
          const r = img.getBoundingClientRect();
          // Accept if visibly large OR if it's an Instagram CDN image
          // (off-screen carousel slides may have zero rect but valid URLs)
          const isCdn = /cdninstagram\.com|fbcdn\.net/.test(src);
          if ((r.width < 100 || r.height < 100) && !isCdn) return;
          const url = bestImgUrl(img);
          if (!url || seen.has(url)) return;
          seen.add(url);
          items.push({ url, video: false, w: Math.max(r.width, 1) });
        } catch (e) {}
      });

      // Collect videos (use captured network URL when available)
      container.querySelectorAll('video').forEach(v => {
        try {
          const r = v.getBoundingClientRect();
          if (r.width < 100) return;
          const src = v.currentSrc || v.src;
          if (src && src.indexOf('http') === 0 && src.indexOf('blob:') !== 0 && !seen.has(src)) {
            seen.add(src);
            items.push({ url: src, video: true, w: r.width });
          }
        } catch (e) {}
      });

      // Sort largest first, return if multiple distinct items found
      items.sort((a, b) => b.w - a.w);
      return items.length > 1 ? items : null;
    } catch (e) { return null; }
  }

  // parse Instagram's carousel_media JSON -> [{url, video}] (best quality each)
  function getCarouselMedia() {
    try {
      // Search script tags' textContent (raw, unescaped) instead of innerHTML
      // (innerHTML HTML-entity-escapes quotes, breaking JSON.parse).
      const marker = '"carousel_media"';
      let html = null;
      const scripts = document.querySelectorAll('script');
      for (const s of scripts) {
        const t = s.textContent || '';
        if (t.indexOf(marker) !== -1 && t.indexOf('image_versions2') !== -1) { html = t; break; }
      }
      // Fallback: unescape entities in innerHTML
      if (!html) {
        html = document.documentElement.innerHTML
          .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
          .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      }
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
          else if (ch === '[' || ch === '{') depth++;
          else if (ch === ']' || ch === '}') { depth--; if (depth === 0) { end = i; break; } }
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
    if (!media) {
      if (confirm('No media found. Show diagnostic info?')) diagnosePage();
      return;
    }
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

  function addButton(container, skipCheck) {
    try {
      if (!container || VOID_TAGS.test(container.tagName)) return;
      if (container.querySelector(':scope > .' + BTN_CLASS)) return;
      // Don't add a button if there's no actual downloadable media here.
      // (Prevents dead ⬇ icons on non-post articles, empty dialogs, etc.)
      // skipCheck=true when the caller already validated media exists.
      if (!skipCheck) {
        let hasMedia = false;
        try {
          const imgs = container.querySelectorAll('img');
          for (const img of imgs) {
            const r = img.getBoundingClientRect();
            if (r.width < 150 || r.height < 150) continue;
            const src = img.currentSrc || img.src || '';
            if (src.startsWith('http') && !/profile_pic|s150x150/.test(src)) { hasMedia = true; break; }
          }
          if (!hasMedia) {
            const vids = container.querySelectorAll('video');
            for (const v of vids) {
              const r = v.getBoundingClientRect();
              if (r.width >= 150) { hasMedia = true; break; }
            }
          }
        } catch (e) {}
        if (!hasMedia) return;
      }
      // Ensure the button positions correctly within its container
      try {
        const cs = window.getComputedStyle(container);
        if (cs.position === 'static') container.style.position = 'relative';
      } catch (e) {}
      const btn = document.createElement('button');
      btn.className = BTN_CLASS;
      btn.textContent = '⬇'; btn.title = 'Download media';
      styleBtn(btn, false);
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        // Shift+Click: show diagnostic immediately
        if (e.shiftKey) { diagnosePage(btn._gqlError); return; }
        // carousel on a direct post page? grab every slide.
        // Strategy: GraphQL API (most reliable), then ?img_index deep links,
        // then slide navigation, then DOM, then JSON.
        if (/^\/(p|reel)\//.test(location.pathname)) {
          btn.textContent = '…';
          (async () => {
            const shortcode = (location.pathname.match(/\/(p|reel)\/([^/]+)/) || [])[2] || '';
            const gqlRes = await getCarouselViaGraphQL(shortcode);
            if (gqlRes.items && gqlRes.items.length > 1) {
              downloadAll(gqlRes.items, shortcode + '_carousel');
              btn.textContent = '✓'; setTimeout(() => btn.textContent = '⬇', 1500);
              return;
            }
            // GraphQL failed — stash error for diagnostic
            btn._gqlError = gqlRes.error || 'unknown';
            // JSON is in the page (diagnostic confirmed) — try it right after GraphQL
            const car = getCarouselMedia();
            if (car && car.length > 1) {
              downloadAll(car, username() + '_carousel');
              btn.textContent = '✓'; setTimeout(() => btn.textContent = '⬇', 1500);
              return;
            }
            const idxCar = await getCarouselViaImgIndex();
            if (idxCar && idxCar.length > 1) {
              const label = (location.pathname.match(/\/(p|reel)\/([^/]+)/) || [])[2] || username();
              downloadAll(idxCar, label + '_carousel');
              btn.textContent = '✓'; setTimeout(() => btn.textContent = '⬇', 1500);
              return;
            }
            const navCar = await getCarouselViaNavigation();
            if (navCar && navCar.length > 1) {
              downloadAll(navCar, username() + '_carousel');
              btn.textContent = '✓'; setTimeout(() => btn.textContent = '⬇', 1500);
              return;
            }
            const domCar = getCarouselMediaFromDOM();
            if (domCar && domCar.length > 1) {
              downloadAll(domCar, username() + '_carousel');
              btn.textContent = '✓'; setTimeout(() => btn.textContent = '⬇', 1500);
              return;
            }
            // Fallback: re-fetch the page HTML and parse carousel from it
            try {
              const r = await fetch(location.href, { credentials: 'include' });
              const html = await r.text();
              const car2 = parseCarouselFromHtml(html);
              if (car2 && car2.length > 1) {
                const label = (location.pathname.match(/\/(p|reel)\/([^/]+)/) || [])[2] || username();
                downloadAll(car2, label + '_carousel');
                btn.textContent = '✓'; setTimeout(() => btn.textContent = '⬇', 1500);
                return;
              }
            } catch (err) {}
            doSingleFromButton();
          })();
          return;
        }
        doSingleFromButton();

        function doSingleFromButton() {
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
        }
      });
      if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
      container.appendChild(btn);
    } catch (e) { /* never let one button kill the scan */ }
  }

  function ensureFab() {
    try {
      // On Instagram: only show FAB as a fallback when no contextual button exists.
      // (Prevents clutter, but guarantees there's always a download option.)
      if (/instagram\.com$/.test(location.hostname)) {
        const hasContextual = document.querySelector('.' + BTN_CLASS + ', .igdl-hover-btn, #igdl-profile-dlall');
        const old = document.getElementById(FAB_ID);
        if (hasContextual) { if (old) old.remove(); return; }
        // No contextual button found — show FAB as fallback
      } else {
        if (document.getElementById(FAB_ID)) return;
      }
      const fab = document.createElement('button');
      fab.id = FAB_ID; fab.textContent = '⬇'; fab.title = 'Download visible post';
      styleBtn(fab, true);
      fab.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.shiftKey) { diagnosePage(fab._gqlError); return; }
        if (/^\/(p|reel)\//.test(location.pathname)) {
          fab.textContent = '…';
          (async () => {
            // GraphQL API first (most reliable)
            const shortcode = (location.pathname.match(/\/(p|reel)\/([^/]+)/) || [])[2] || '';
            const gqlRes = await getCarouselViaGraphQL(shortcode);
            if (gqlRes.items && gqlRes.items.length > 1) {
              downloadAll(gqlRes.items, shortcode + '_carousel');
              fab.textContent = '✓'; setTimeout(() => fab.textContent = '⬇', 1500);
              return;
            }
            fab._gqlError = gqlRes.error || 'unknown';
            // JSON is in the page — try it right after GraphQL
            const car = getCarouselMedia();
            if (car && car.length > 1) {
              downloadAll(car, username() + '_carousel');
              fab.textContent = '✓'; setTimeout(() => fab.textContent = '⬇', 1500);
              return;
            }
            // ?img_index=N deep links
            const idxCar = await getCarouselViaImgIndex();
            if (idxCar && idxCar.length > 1) {
              const label = (location.pathname.match(/\/(p|reel)\/([^/]+)/) || [])[2] || username();
              downloadAll(idxCar, label + '_carousel');
              fab.textContent = '✓'; setTimeout(() => fab.textContent = '⬇', 1500);
              return;
            }
            // Navigate through slides
            const navCar = await getCarouselViaNavigation();
            if (navCar && navCar.length > 1) {
              downloadAll(navCar, username() + '_carousel');
              fab.textContent = '✓'; setTimeout(() => fab.textContent = '⬇', 1500);
              return;
            }
            const domCar = getCarouselMediaFromDOM();
            if (domCar && domCar.length > 1) {
              downloadAll(domCar, username() + '_carousel');
              fab.textContent = '✓'; setTimeout(() => fab.textContent = '⬇', 1500);
              return;
            }
            try {
              const r = await fetch(location.href, { credentials: 'include' });
              const html = await r.text();
              const car2 = parseCarouselFromHtml(html);
              if (car2 && car2.length > 1) {
                const label = (location.pathname.match(/\/(p|reel)\/([^/]+)/) || [])[2] || username();
                downloadAll(car2, label + '_carousel');
              } else {
                doDownload(findBestMedia());
              }
            } catch (err) { doDownload(findBestMedia()); }
            fab.textContent = '✓'; setTimeout(() => fab.textContent = '⬇', 1500);
          })();
          return;
        }
        doDownload(findBestMedia());
        fab.textContent = '✓'; setTimeout(() => fab.textContent = '⬇', 1500);
      });
      (document.body || document.documentElement).appendChild(fab);
    } catch (e) {}
  }

  // ---------- Turbo-style: Profile "Download All" button ----------
  function isProfilePage() {
    try {
      if (!/instagram\.com$/.test(location.hostname)) return false;
      const m = location.pathname.match(/^\/([a-zA-Z0-9._]{1,30})\/?$/);
      if (!m) return false;
      const reserved = ['explore', 'reels', 'stories', 'direct', 'accounts', 'about',
        'legal', 'privacy', 'emails', 'developer', 'p', 'reel', 'tv', 'stories'];
      return reserved.indexOf(m[1].toLowerCase()) === -1;
    } catch (e) { return false; }
  }

  function ensureProfileDownloadAll() {
    try {
      const existing = document.getElementById('igdl-profile-dlall');
      if (!isProfilePage()) { if (existing) existing.remove(); return; }
      if (existing) return;
      // Find the profile header's button row (Follow/Message buttons area)
      const header = document.querySelector('header');
      if (!header) return;
      // Look for the div containing action buttons, or fall back to header itself
      let anchor = null;
      const btns = header.querySelectorAll('button');
      for (const b of btns) {
        const t = (b.textContent || '').toLowerCase();
        if (t.includes('follow') || t.includes('message') || t.includes('edit profile')) {
          anchor = b.parentElement;
          break;
        }
      }
      const wrap = document.createElement('div');
      wrap.id = 'igdl-profile-dlall';
      wrap.style.cssText = 'display:inline-flex;margin-left:8px;vertical-align:middle;';
      const btn = document.createElement('button');
      btn.textContent = '⬇ Download All';
      btn.title = 'Download all posts from this profile. Re-running saves additional copies of files already downloaded.';
      btn.style.cssText = 'background:#0095f6;color:#fff;border:none;border-radius:8px;' +
        'padding:8px 16px;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;';
      btn.addEventListener('click', (e) => {
        e.stopPropagation(); e.preventDefault();
        bulkDownload();
      });
      wrap.appendChild(btn);
      if (anchor && anchor.parentElement) {
        anchor.parentElement.insertBefore(wrap, anchor.nextSibling);
      } else {
        header.appendChild(wrap);
      }
    } catch (e) {}
  }

  // ---------- Turbo-style: hover download button on grid previews ----------
  // Parse carousel_media from HTML string -> [{url, video}]
  function parseCarouselFromHtml(html) {
    try {
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

  async function fetchPostMedia(href) {
    try {
      const url = href.indexOf('http') === 0 ? href : 'https://www.instagram.com' + href;
      const resp = await fetch(url, { credentials: 'include' });
      if (!resp.ok) return null;
      const html = await resp.text();
      // Carousel? Return ALL slides.
      const car = parseCarouselFromHtml(html);
      if (car && car.length > 1) return { carousel: car };
      // Best video from video_versions
      let best = null, bestPx = 0;
      const vm = html.match(/"video_versions"\s*:\s*\[(.*?)\]/);
      if (vm) {
        const ure = /"url"\s*:\s*"(https:[^"]+?)"[^}]*?"width"\s*:\s*(\d+)[^}]*?"height"\s*:\s*(\d+)/g;
        let um;
        while ((um = ure.exec(vm[1])) !== null) {
          const px = (+um[2]) * (+um[3]);
          if (px > bestPx && um[1].indexOf('.mp4') !== -1) {
            bestPx = px;
            try { best = JSON.parse('"' + um[1] + '"'); } catch (e) {}
          }
        }
        if (best) return { url: best, video: true };
      }
      const ogV = html.match(/<meta[^>]+property="og:video(?::secure_url)?"[^>]+content="([^"]+)"/);
      if (ogV && ogV[1].indexOf('http') === 0) return { url: ogV[1], video: true };
      const ogI = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
      if (ogI && ogI[1].indexOf('http') === 0) return { url: ogI[1], video: false };
    } catch (e) {}
    return null;
  }

  function addHoverButton(link) {
    try {
      if (!link || link.querySelector(':scope > .igdl-hover-btn')) return;
      const img = link.querySelector('img');
      if (!img) return;
      const btn = document.createElement('button');
      btn.className = 'igdl-hover-btn';
      btn.textContent = '⬇';
      btn.title = 'Download this post';
      btn.style.cssText = 'position:absolute;top:8px;right:8px;width:34px;height:34px;' +
        'border-radius:50%;background:rgba(0,149,246,.92);color:#fff;' +
        'border:2px solid rgba(255,255,255,.85);font-size:16px;cursor:pointer;z-index:1000;' +
        'opacity:0;transition:opacity .18s;display:flex;align-items:center;justify-content:center;';
      link.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
      link.addEventListener('mouseleave', () => { btn.style.opacity = '0'; });
      btn.addEventListener('click', async (e) => {
        e.stopPropagation(); e.preventDefault();
        const href = link.getAttribute('href');
        if (!href) return;
        btn.textContent = '…'; btn.style.opacity = '1';
        try {
          const postUrl = href.indexOf('http') === 0 ? href : 'https://www.instagram.com' + href;
          const cleanUrl = postUrl.split('?')[0];
          const shortcode = (cleanUrl.match(/\/(p|reel)\/([^/]+)/) || [])[2] || '';
          // GraphQL API first (most reliable for carousels)
          const gqlCar = await getCarouselViaGraphQL(shortcode);
          if (gqlCar && gqlCar.length > 1) {
            downloadAll(gqlCar, shortcode + '_carousel');
            btn.textContent = '✓';
          } else {
            // Fallback: ?img_index deep links
            const seen = new Set();
            const carItems = [];
            for (let i = 0; i < 10; i++) {
              try {
                const resp = await fetch(cleanUrl + '?img_index=' + i, { credentials: 'include' });
                if (!resp.ok) break;
                const html = await resp.text();
                const m = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
                if (m && m[1].indexOf('http') === 0 && !seen.has(m[1])) {
                  seen.add(m[1]);
                  carItems.push({ url: m[1], video: false });
                } else if (i > 0 && carItems.length === 0) break;
                await new Promise(r => setTimeout(r, 250));
              } catch (err) { break; }
              if (carItems.length >= 10) break;
            }
            if (carItems.length > 1) {
              const label = (cleanUrl.match(/\/(p|reel)\/([^/]+)/) || [])[2] || username();
              downloadAll(carItems, label + '_carousel');
              btn.textContent = '✓';
            } else {
              const media = await fetchPostMedia(href);
              if (media && media.carousel) {
                const label = (href.match(/\/(p|reel)\/([^/]+)/) || [])[2] || username();
                downloadAll(media.carousel, label + '_carousel');
                btn.textContent = '✓';
              } else if (media) {
                doDownload(Promise.resolve(media));
                btn.textContent = '✓';
              } else {
                const url = bestImgUrl(img);
                if (url) { doDownload(Promise.resolve({ url, video: false })); btn.textContent = '✓'; }
                else btn.textContent = '✗';
              }
            }
          }
        } catch (err) { btn.textContent = '✗'; }
        setTimeout(() => { btn.textContent = '⬇'; btn.style.opacity = '0'; }, 1500);
      });
      if (getComputedStyle(link).position === 'static') link.style.position = 'relative';
      link.appendChild(btn);
    } catch (e) {}
  }

  function scan() {
    try {
      // Profile pages: Download All button + hover buttons on grid
      ensureProfileDownloadAll();
      if (isProfilePage() || /^\/explore\/?$/.test(location.pathname)) {
        document.querySelectorAll('a[href^="/p/"], a[href^="/reel/"]').forEach(a => {
          const r = a.getBoundingClientRect();
          // Grid thumbnails are small squares; skip the main post view links
          if (r.width > 40 && r.width < 500 && r.height > 40 && r.height < 500) {
            addHoverButton(a);
          }
        });
      }
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
          if (target) addButton(buttonHost(target), true);
          else {
            // Fallback: no large media found (lazy-load, odd layout) —
            // pin button directly on main so there's always a download option.
            addButton(main, true);
          }
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
          if (target) addButton(buttonHost(target), true);
        }
      }
      document.querySelectorAll('article').forEach(a => {
        // On direct post pages, skip the media check — we know there's media.
        const skip = /^\/(p|reel|reels)\//.test(location.pathname);
        addButton(a, skip);
      });
      document.querySelectorAll('a[href^="/p/"], a[href^="/reel/"], a[href*="/p/"], a[href*="/reel/"]').forEach(a => {
        // Skip links nested inside an article — the article already has its own button.
        // (Prevents double ⬇ icons on the same post.)
        if (a.closest('article')) return;
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
