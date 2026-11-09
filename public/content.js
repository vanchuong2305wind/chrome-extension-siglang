/**
 * content.js
 * Chạy trên trang YouTube / trang web chứa video:
 * 1. Hiển thị Nút Icon Nổi (Floating Action Icon) và Bảng 3D Nổi (Floating Panel)
 *    ngay trên góc màn hình trang web theo phong cách Earthy Warm & Organic:
 *    - Có thể dùng chuột kéo di chuyển (Drag & Drop) đến bất kỳ vị trí nào trên màn hình.
 *    - Click vào icon để Mở bảng ngôn ngữ ký hiệu 3D, click lại vào icon để Đóng/Thu gọn.
 *    - Khi bấm vào tua/dừng video trên YouTube, bảng 3D vẫn giữ nguyên trên màn hình, KHÔNG bị tắt.
 * 2. Đọc trực tiếp thời gian phát (currentTime), trạng thái dừng/phát của thẻ <video>.
 * 3. Trích xuất danh sách caption tracks từ YouTube player (ytInitialPlayerResponse)
 *    và nối các âm tiết bị ngắt dòng thành câu hoàn chỉnh.
 */

(() => {
  if (window.__signlangContentLoaded) return;
  window.__signlangContentLoaded = true;

  let lastEmittedLiveCaption = '';
  let pendingLiveCaption = '';
  let liveCaptionDebounceTimer = null;
  let captionObserver = null;

  let cachedCuesUrl = '';
  let cachedCuesResult = null;

  /* ==========================================================================
     1. FLOATING ICON & DRAGGABLE IN-PAGE 3D PANEL (SHADOW DOM)
     ========================================================================== */

  let widgetState = {
    isOpen: false,
    x: null,
    y: null,
    panelX: null,
    panelY: null,
  };

  function createFloatingWidget() {
    // Không chèn nút nổi nếu bản thân đang ở trong iframe nhỏ
    if (window.top !== window.self) return;
    if (document.getElementById('signlang-3d-floating-root')) return;

    const host = document.createElement('div');
    host.id = 'signlang-3d-floating-root';
    host.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483646;font-family:Manrope,sans-serif;';
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; user-select: none; }

      .sl-fab {
        position: fixed;
        right: 22px;
        bottom: 26px;
        width: 56px;
        height: 56px;
        border-radius: 100px;
        background: #522B12;
        color: #FFFCED;
        border: 2px solid #E8E6DA;
        box-shadow: 0 8px 26px rgba(75, 45, 21, 0.35), 0 0 0 3px rgba(50, 88, 37, 0.18);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        cursor: grab;
        pointer-events: auto;
        transition: background-color 0.2s ease, transform 0.18s ease, box-shadow 0.2s ease;
        z-index: 2147483647;
      }

      .sl-fab:hover {
        background: #5F2A1A;
        transform: scale(1.06);
        box-shadow: 0 10px 30px rgba(82, 43, 18, 0.45), 0 0 0 4px rgba(50, 88, 37, 0.28);
      }

      .sl-fab.dragging {
        cursor: grabbing;
        transform: scale(1.08);
        transition: none;
      }

      .sl-fab.open {
        background: #325825;
        border-color: #FFFCED;
      }

      .sl-fab-badge {
        font-family: Georgia, 'Times New Roman', serif;
        font-style: italic;
        font-weight: 800;
        font-size: 14px;
        line-height: 1;
        letter-spacing: -0.3px;
      }

      .sl-fab-sub {
        font-size: 8.5px;
        font-weight: 700;
        letter-spacing: 0.5px;
        text-transform: uppercase;
        opacity: 0.9;
        margin-top: 2px;
      }

      .sl-fab-dot {
        position: absolute;
        top: 2px;
        right: 2px;
        width: 12px;
        height: 12px;
        border-radius: 50%;
        background: #307436;
        border: 2px solid #FFFCED;
      }

      .sl-fab-tooltip {
        position: absolute;
        right: 66px;
        top: 50%;
        transform: translateY(-50%);
        background: #FFFCED;
        color: #4B2D15;
        border: 1px solid rgba(75, 45, 21, 0.2);
        box-shadow: 0 6px 18px rgba(75, 45, 21, 0.16);
        padding: 6px 12px;
        border-radius: 100px;
        font-size: 11.5px;
        font-weight: 700;
        white-space: nowrap;
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.2s ease;
      }

      .sl-fab:hover .sl-fab-tooltip {
        opacity: 1;
      }

      .sl-panel {
        position: fixed;
        right: 22px;
        bottom: 92px;
        width: 420px;
        height: 625px;
        max-width: calc(100vw - 24px);
        max-height: calc(100vh - 108px);
        background: #FFFCED;
        border: 2px solid rgba(75, 45, 21, 0.25);
        border-radius: 20px;
        box-shadow: 0 20px 50px rgba(35, 18, 6, 0.32);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        pointer-events: auto;
        z-index: 2147483646;
        transition: opacity 0.2s ease, transform 0.2s ease;
      }

      .sl-panel.hidden {
        opacity: 0;
        pointer-events: none;
        transform: translateY(14px) scale(0.96);
      }

      /* Khi bật chế độ Full màn hình nhân vật 3D */
      .sl-panel.full-avatar .sl-panel-dragbar {
        display: none;
      }

      .sl-panel-dragbar {
        height: 32px;
        background: #E8E6DA;
        border-bottom: 1px solid rgba(75, 45, 21, 0.14);
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 12px;
        cursor: grab;
        color: #4B2D15;
        font-size: 11px;
        font-weight: 700;
      }

      .sl-panel-dragbar:active {
        cursor: grabbing;
      }

      .sl-drag-grip {
        display: flex;
        align-items: center;
        gap: 6px;
        font-family: Georgia, serif;
        font-style: italic;
      }

      .sl-drag-dots {
        display: inline-block;
        letter-spacing: 1px;
        opacity: 0.6;
        font-style: normal;
      }

      .sl-panel-close {
        border: none;
        background: rgba(75, 45, 21, 0.1);
        color: #522B12;
        border-radius: 100px;
        padding: 2px 10px;
        font-size: 10.5px;
        font-weight: 700;
        cursor: pointer;
        transition: all 0.15s ease;
      }

      .sl-panel-close:hover {
        background: #5F2A1A;
        color: #FFFCED;
      }

      .sl-iframe {
        width: 100%;
        flex: 1;
        border: none;
        background: #FFFCED;
      }
    `;

    // Nút Icon Nổi (Floating Action Button)
    const fab = document.createElement('button');
    fab.className = 'sl-fab';
    fab.type = 'button';
    fab.setAttribute('aria-label', 'SignLang 3D — Bật/Tắt phiên dịch ngôn ngữ ký hiệu 3D');
    fab.innerHTML = `
      <span class="sl-fab-dot"></span>
      <span class="sl-fab-badge">3D</span>
      <span class="sl-fab-sub">Sign</span>
      <span class="sl-fab-tooltip">Kéo để di chuyển • Click để Bật/Tắt 3D</span>
    `;

    // Khung Bảng 3D Nổi (Floating Panel)
    const panel = document.createElement('div');
    panel.className = 'sl-panel hidden';

    const dragBar = document.createElement('div');
    dragBar.className = 'sl-panel-dragbar';
    dragBar.innerHTML = `
      <span class="sl-drag-grip">
        <span class="sl-drag-dots">⋮⋮</span>
        <span>SignLang 3D — Kéo thanh này để di chuyển</span>
      </span>
      <button type="button" class="sl-panel-close" title="Thu gọn xuống icon">Thu gọn ✕</button>
    `;

    const iframe = document.createElement('iframe');
    iframe.className = 'sl-iframe';
    iframe.allow = 'microphone; autoplay; clipboard-write';
    let iframeInitialized = false;

    panel.appendChild(dragBar);
    panel.appendChild(iframe);

    shadow.appendChild(style);
    shadow.appendChild(panel);
    shadow.appendChild(fab);
    document.documentElement.appendChild(host);

    // Khôi phục vị trí đã lưu nếu có
    try {
      chrome.storage?.local?.get(['signlang_fab_pos'], (res) => {
        const pos = res?.signlang_fab_pos;
        if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
          applyFabPosition(pos.x, pos.y);
        }
      });
    } catch {
      // ignore
    }

    function applyFabPosition(x, y) {
      const maxX = Math.max(window.innerWidth - 64, 8);
      const maxY = Math.max(window.innerHeight - 64, 8);
      const clampedX = Math.min(Math.max(8, x), maxX);
      const clampedY = Math.min(Math.max(8, y), maxY);

      fab.style.left = `${clampedX}px`;
      fab.style.top = `${clampedY}px`;
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
      widgetState.x = clampedX;
      widgetState.y = clampedY;

      // Nếu bảng chưa bị kéo riêng thì tự động đặt bảng nằm cạnh nút icon
      if (widgetState.panelX === null && widgetState.panelY === null) {
        positionPanelNearFab(clampedX, clampedY);
      }
    }

    function positionPanelNearFab(fabX, fabY) {
      const panelW = 420;
      const panelH = Math.min(625, window.innerHeight - 100);
      let px = fabX - panelW + 56;
      if (px < 12) px = Math.min(fabX, window.innerWidth - panelW - 12);
      let py = fabY - panelH - 12;
      if (py < 12) py = Math.min(fabY + 66, window.innerHeight - panelH - 12);

      panel.style.left = `${Math.max(10, px)}px`;
      panel.style.top = `${Math.max(10, py)}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }

    function togglePanel(forceState) {
      const next = typeof forceState === 'boolean' ? forceState : !widgetState.isOpen;
      widgetState.isOpen = next;

      if (next && !iframeInitialized) {
        iframeInitialized = true;
        iframe.src = chrome.runtime.getURL('popup.html?overlay=1');
      }

      if (next) {
        panel.classList.remove('hidden');
        fab.classList.add('open');
        if (widgetState.x !== null && widgetState.panelX === null) {
          positionPanelNearFab(widgetState.x, widgetState.y);
        }
      } else {
        panel.classList.add('hidden');
        fab.classList.remove('open');
      }
    }

    // Kéo thả nút Icon Nổi (phân biệt rõ giữa Kéo di chuyển và Click Bật/Tắt)
    let fabDrag = { active: false, moved: false, startX: 0, startY: 0, origX: 0, origY: 0 };

    fab.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const rect = fab.getBoundingClientRect();
      fabDrag = {
        active: true,
        moved: false,
        startX: e.clientX,
        startY: e.clientY,
        origX: rect.left,
        origY: rect.top,
      };
      fab.setPointerCapture(e.pointerId);
    });

    fab.addEventListener('pointermove', (e) => {
      if (!fabDrag.active) return;
      const dx = e.clientX - fabDrag.startX;
      const dy = e.clientY - fabDrag.startY;
      if (Math.hypot(dx, dy) > 5) {
        fabDrag.moved = true;
        fab.classList.add('dragging');
      }
      if (fabDrag.moved) {
        applyFabPosition(fabDrag.origX + dx, fabDrag.origY + dy);
      }
    });

    fab.addEventListener('pointerup', (e) => {
      if (!fabDrag.active) return;
      fabDrag.active = false;
      fab.classList.remove('dragging');
      try {
        fab.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      if (fabDrag.moved) {
        try {
          chrome.storage?.local?.set({
            signlang_fab_pos: { x: widgetState.x, y: widgetState.y },
          });
        } catch {
          // ignore
        }
      } else {
        // Không kéo mà chỉ click -> Mở hoặc Đóng bảng 3D
        togglePanel();
      }
    });

    // Kéo thả trực tiếp Bảng 3D Nổi bằng thanh tiêu đề trên cùng
    let panelDrag = { active: false, startX: 0, startY: 0, origX: 0, origY: 0 };

    dragBar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.sl-panel-close')) return;
      const rect = panel.getBoundingClientRect();
      panelDrag = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        origX: rect.left,
        origY: rect.top,
      };
      dragBar.setPointerCapture(e.pointerId);
    });

    dragBar.addEventListener('pointermove', (e) => {
      if (!panelDrag.active) return;
      const dx = e.clientX - panelDrag.startX;
      const dy = e.clientY - panelDrag.startY;
      const maxX = Math.max(window.innerWidth - panel.offsetWidth - 8, 8);
      const maxY = Math.max(window.innerHeight - panel.offsetHeight - 8, 8);
      const nx = Math.min(Math.max(8, panelDrag.origX + dx), maxX);
      const ny = Math.min(Math.max(8, panelDrag.origY + dy), maxY);
      panel.style.left = `${nx}px`;
      panel.style.top = `${ny}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      widgetState.panelX = nx;
      widgetState.panelY = ny;
    });

    dragBar.addEventListener('pointerup', (e) => {
      panelDrag.active = false;
      try {
        dragBar.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    });

    dragBar.querySelector('.sl-panel-close')?.addEventListener('click', () => {
      togglePanel(false);
    });

    // Nhận tín hiệu từ iframe khi bật/tắt chế độ Full màn hình nhân vật 3D
    window.addEventListener('message', (event) => {
      if (event?.data?.type === 'SIGNLANG_FULL_AVATAR') {
        if (event.data.value) {
          panel.classList.add('full-avatar');
        } else {
          panel.classList.remove('full-avatar');
        }
      }
    });

    window.__signlangTogglePanel = togglePanel;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createFloatingWidget);
  } else {
    createFloatingWidget();
  }

  /* ==========================================================================
     2. VIDEO SYNC & YOUTUBE CAPTION EXTRACTION
     ========================================================================== */

  function getPrimaryVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (videos.length === 0) return null;
    const playing = videos.find((v) => !v.paused && v.readyState >= 2);
    if (playing) return playing;
    return videos.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  }

  function getLiveYouTubeCaptionText() {
    const ytSegments = document.querySelectorAll('.ytp-caption-segment');
    if (ytSegments && ytSegments.length > 0) {
      const text = Array.from(ytSegments)
        .map((el) => el.textContent || '')
        .join(' ')
        .replace(/\[.*?\]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (text) return text;
    }

    const video = getPrimaryVideo();
    if (video && video.textTracks) {
      for (let i = 0; i < video.textTracks.length; i++) {
        const track = video.textTracks[i];
        if (track.mode === 'showing' && track.activeCues && track.activeCues.length > 0) {
          const cuesText = Array.from(track.activeCues)
            .map((c) => c.text || '')
            .join(' ')
            .replace(/<[^>]+>/g, '')
            .replace(/\[.*?\]/g, '')
            .replace(/\s+/g, ' ')
            .trim();
          if (cuesText) return cuesText;
        }
      }
    }

    return '';
  }

  function getVideoState() {
    const video = getPrimaryVideo();
    const isYouTube = /youtube\.com/i.test(location.hostname);
    const liveCaption = getLiveYouTubeCaptionText();

    let title = document.title.replace(/\s*-\s*YouTube$/i, '').trim();
    const ytTitleEl = document.querySelector(
      'h1.ytd-watch-metadata yt-formatted-string, #title h1'
    );
    if (ytTitleEl?.textContent) {
      title = ytTitleEl.textContent.trim();
    }

    return {
      hasVideo: !!video,
      isYouTube,
      url: location.href,
      title,
      currentTime: video ? video.currentTime : 0,
      duration: video && Number.isFinite(video.duration) ? video.duration : 0,
      paused: video ? video.paused : true,
      playbackRate: video ? video.playbackRate : 1,
      liveCaption,
    };
  }

  function ensureYouTubeCaptionsEnabled() {
    const ccBtn = document.querySelector('.ytp-subtitles-button');
    if (ccBtn && ccBtn.getAttribute('aria-pressed') === 'false') {
      ccBtn.click();
      return true;
    }
    return false;
  }

  async function extractYouTubeCaptionTracks() {
    try {
      const videoUrl = location.href;
      const resp = await fetch(videoUrl, { credentials: 'include' });
      const html = await resp.text();

      const marker = 'ytInitialPlayerResponse = ';
      const idx = html.indexOf(marker);
      if (idx === -1) return [];

      const start = idx + marker.length;
      let depth = 0;
      let end = start;
      let inString = false;
      let escape = false;

      for (let i = start; i < Math.min(html.length, start + 600000); i++) {
        const ch = html[i];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\') {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (!inString) {
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              end = i + 1;
              break;
            }
          }
        }
      }

      const jsonStr = html.slice(start, end);
      const playerResponse = JSON.parse(jsonStr);
      const tracklist =
        playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

      return tracklist.map((t) => ({
        baseUrl: t.baseUrl,
        languageCode: t.languageCode,
        name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
        vssId: t.vssId || '',
        kind: t.kind || 'manual',
      }));
    } catch (err) {
      console.warn('[SignLang Content] Không lấy được danh sách track từ trang:', err);
      return [];
    }
  }

  const COMPOUND_JOINS = new Set([
    'xin chào', 'mọi người', 'đầu tiên', 'ký hiệu', 'biểu hiện', 'cảm xúc',
    'giận dữ', 'nóng tính', 'nghi ngờ', 'yên tâm', 'không hiểu', 'không thích',
    'thông cảm', 'tình cảm', 'hồi hộp', 'xấu hổ', 'mắc cỡ', 'tò mò',
    'ngạc nhiên', 'chấp nhận', 'không biết', 'buổi học', 'bài học',
    'kết thúc', 'cố gắng', 'có thể', 'tham gia', 'tiếp theo', 'cảm ơn',
    'theo dõi', 'hẹn gặp', 'gặp lại',
  ]);

  function buildCleanCuesFromJson3Events(rawEvents) {
    const timedWords = [];

    for (const ev of rawEvents) {
      if (!ev.segs) continue;
      const baseMs = ev.tStartMs || 0;
      const durMs = ev.dDurationMs || 2500;

      for (const seg of ev.segs) {
        const rawText = (seg.utf8 || '')
          .replace(/\[.*?\]/g, ' ')
          .replace(/\n+/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (!rawText) continue;

        const tSec = (baseMs + (seg.tOffsetMs || 0)) / 1000;
        const endSec = (baseMs + durMs) / 1000;

        const parts = rawText.split(' ').filter(Boolean);
        parts.forEach((word, idx) => {
          timedWords.push({
            word,
            start: Number((tSec + idx * 0.08).toFixed(2)),
            eventEnd: Number(endSec.toFixed(2)),
          });
        });
      }
    }

    if (timedWords.length === 0) return [];

    const segments = [];
    let current = null;

    for (let i = 0; i < timedWords.length; i++) {
      const item = timedWords[i];
      if (!current) {
        current = {
          start: item.start,
          end: Math.max(item.start + 1.8, item.eventEnd),
          lastWordTime: item.start,
          words: [item.word],
        };
        continue;
      }

      const lastW = current.words[current.words.length - 1].toLowerCase();
      const nextW = item.word.toLowerCase();
      const isCompoundJoin = COMPOUND_JOINS.has(`${lastW} ${nextW}`);

      const gapFromLastWord = item.start - current.lastWordTime;
      const totalSpan = item.start - current.start;
      const wordCount = current.words.length;

      const shouldSplit =
        (!isCompoundJoin || gapFromLastWord > 3.5) &&
        (gapFromLastWord >= 1.65 ||
          (wordCount >= 8 && gapFromLastWord >= 0.45 && !isCompoundJoin) ||
          wordCount >= 11 ||
          totalSpan >= 6.0);

      if (shouldSplit) {
        current.end = Number(
          Math.min(Math.max(current.lastWordTime + 1.5, current.start + 1.2), item.start).toFixed(2)
        );
        segments.push({
          start: current.start,
          end: current.end,
          text: current.words.join(' '),
        });
        current = {
          start: item.start,
          end: Math.max(item.start + 1.8, item.eventEnd),
          lastWordTime: item.start,
          words: [item.word],
        };
      } else {
        current.words.push(item.word);
        current.lastWordTime = item.start;
        current.end = Math.max(current.end, item.lastWordTime + 1.5);
      }
    }

    if (current && current.words.length > 0) {
      segments.push({
        start: current.start,
        end: Number((current.lastWordTime + 2.0).toFixed(2)),
        text: current.words.join(' '),
      });
    }

    return segments;
  }

  async function fetchYouTubeCues(langPref = 'vi') {
    const currentUrl = location.href;
    if (cachedCuesUrl === currentUrl && cachedCuesResult?.cues?.length > 0) {
      return cachedCuesResult;
    }

    const tracks = await extractYouTubeCaptionTracks();
    if (!tracks.length) {
      return {
        ok: false,
        cues: [],
        message:
          'Video này không có sẵn track phụ đề tĩnh, đang dùng chế độ bắt phụ đề/âm thanh trực tiếp.',
      };
    }

    const scored = tracks
      .map((t) => {
        const code = (t.languageCode || '').toLowerCase();
        let score = 50;
        if (code === langPref) score = 0;
        else if (code.startsWith('vi')) score = 1;
        else if (code.startsWith('en')) score = 2;
        if (t.kind === 'asr') score += 0.5;
        return { score, track: t };
      })
      .sort((a, b) => a.score - b.score);

    const chosen = scored[0].track;
    let fetchUrl = chosen.baseUrl;
    if (!fetchUrl.includes('fmt=')) {
      fetchUrl += (fetchUrl.includes('?') ? '&' : '?') + 'fmt=json3';
    }
    let translatedToVi = false;
    if (!chosen.languageCode.toLowerCase().startsWith('vi')) {
      fetchUrl += '&tlang=vi';
      translatedToVi = true;
    }

    try {
      const res = await fetch(fetchUrl, { credentials: 'include' });
      const text = await res.text();
      const data = JSON.parse(text);
      const rawEvents = data.events || [];
      const cues = buildCleanCuesFromJson3Events(rawEvents);

      const result = {
        ok: cues.length > 0,
        language: translatedToVi ? `${chosen.languageCode} → vi` : chosen.languageCode,
        trackName: chosen.name,
        cues,
      };
      if (result.ok) {
        cachedCuesUrl = currentUrl;
        cachedCuesResult = result;
      }
      return result;
    } catch (err) {
      return {
        ok: false,
        cues: [],
        message: 'Đang dùng chế độ bắt lời thoại trực tiếp từ trình phát.',
      };
    }
  }

  function startLiveCaptionObserver() {
    if (captionObserver) return;
    captionObserver = new MutationObserver(() => {
      const text = getLiveYouTubeCaptionText();
      if (!text || text === pendingLiveCaption) return;
      pendingLiveCaption = text;

      clearTimeout(liveCaptionDebounceTimer);
      liveCaptionDebounceTimer = setTimeout(() => {
        if (pendingLiveCaption && pendingLiveCaption !== lastEmittedLiveCaption) {
          lastEmittedLiveCaption = pendingLiveCaption;
          chrome.runtime
            .sendMessage({
              type: 'LIVE_CAPTION_UPDATE',
              text: pendingLiveCaption,
              state: getVideoState(),
            })
            .catch(() => {});
        }
      }, 450);
    });

    captionObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  startLiveCaptionObserver();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'TOGGLE_INPAGE_PANEL') {
      if (typeof window.__signlangTogglePanel === 'function') {
        window.__signlangTogglePanel(msg.open);
      }
      sendResponse({ ok: true, isOpen: widgetState.isOpen });
      return false;
    }

    if (msg?.type === 'GET_VIDEO_STATE') {
      sendResponse(getVideoState());
      return false;
    }

    if (msg?.type === 'ENABLE_YT_CC') {
      const clicked = ensureYouTubeCaptionsEnabled();
      sendResponse({ ok: true, clicked, state: getVideoState() });
      return false;
    }

    if (msg?.type === 'FETCH_YT_CUES') {
      ensureYouTubeCaptionsEnabled();
      if (msg.force) {
        cachedCuesUrl = '';
        cachedCuesResult = null;
      }
      fetchYouTubeCues(msg.lang || 'vi').then(sendResponse);
      return true;
    }

    if (msg?.type === 'SEEK_VIDEO') {
      const video = getPrimaryVideo();
      if (video && typeof msg.time === 'number') {
        video.currentTime = msg.time;
        video.play().catch(() => {});
      }
      sendResponse(getVideoState());
      return false;
    }

    if (msg?.type === 'TOGGLE_PLAY_VIDEO') {
      const video = getPrimaryVideo();
      if (video) {
        if (video.paused) video.play().catch(() => {});
        else video.pause();
      }
      sendResponse(getVideoState());
      return false;
    }

    return false;
  });
})();
