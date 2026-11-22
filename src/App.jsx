/**
 * App.jsx — Giao diện Popup chính của Chrome Extension SignLang 3D
 * Phong cách thiết kế: EARTHY WARM & ORGANIC PORTFOLIO
 *
 * Nâng cấp tốc độ tối đa:
 *  - Bộ phân tích từ điển chỉ mục O(1) tức thì (0ms), bỏ qua hoàn toàn các từ không có trong từ điển.
 *  - Ngay khi đồng bộ được phụ đề video YouTube, tự động dịch sẵn toàn bộ các câu (pre-parse)
 *    và nạp trước (prefetch) các file tọa độ 3D vào RAM để khi video phát tới đâu là nhân vật 3D
 *    biểu diễn ngay lập tức không có độ trễ.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import {
  Mic,
  MicOff,
  Tv,
  Play,
  Pause,
  RotateCcw,
  Send,
  ExternalLink,
  Volume2,
  Subtitles,
  Maximize2,
  Minimize2,
  ListMusic,
} from 'lucide-react';
import AvatarScene3D from './components/avatar/AvatarScene3D';
import useSpeechRecognition from './hooks/useSpeechRecognition';
import { translateTextToSigns, signDict } from './services/signEngine';
import { translateTextToVieSigns, viesignDict } from './services/viesignEngine';

// VieSign (ký hiệu Việt Nam, giống signlangue) là mặc định; bộ ASL/WLASL cũ vẫn giữ để chọn lại.
const DATASETS = {
  viesign: { label: 'VieSign', title: 'Ngôn ngữ ký hiệu Việt Nam (VieSign)', dict: viesignDict, translate: translateTextToVieSigns },
  asl: { label: 'ASL', title: 'Bộ dữ liệu ASL/WLASL cũ (2000 từ)', dict: signDict, translate: translateTextToSigns },
};
const DATASET_STORAGE_KEY = 'signlang.dataset';

function readSavedDataset() {
  try {
    const saved = window.localStorage.getItem(DATASET_STORAGE_KEY);
    return DATASETS[saved] ? saved : 'viesign';
  } catch {
    return 'viesign';
  }
}
import './App.css';

function formatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const total = Math.floor(sec);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function findCueIndex(cues, time) {
  if (!cues || !cues.length) return -1;
  let low = 0;
  let high = cues.length - 1;
  let candidate = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cues[mid].start <= time) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (candidate < 0) return -1;
  const next = cues[candidate + 1];
  const until = next ? Math.max(cues[candidate].end, next.start) : cues[candidate].end + 2;
  return time <= until ? candidate : -1;
}

const SAMPLE_SENTENCES = [
  'Xin chào mọi người',
  'Vui buồn giận ghét thương',
  'Hồi hộp xấu hổ ngạc nhiên',
  'Cảm ơn và hẹn gặp lại',
];

export default function App() {
  const avatarRef = useRef(null);
  const activeCueItemRef = useRef(null);

  const [sourceMode, setSourceMode] = useState('tab');
  const [isFullAvatar, setIsFullAvatar] = useState(false);

  const [targetTabId, setTargetTabId] = useState(null);
  const [videoState, setVideoState] = useState({
    hasVideo: false,
    isYouTube: false,
    title: '',
    currentTime: 0,
    duration: 0,
    paused: true,
    liveCaption: '',
  });
  const [cues, setCues] = useState([]);
  const [activeCueIdx, setActiveCueIdx] = useState(-1);
  const [autoSyncVideo, setAutoSyncVideo] = useState(true);
  const [showCueList, setShowCueList] = useState(false);
  const [captionNotice, setCaptionNotice] = useState('');

  const [currentText, setCurrentText] = useState('');
  const [interimText, setInterimText] = useState('');
  const [translation, setTranslation] = useState(null);
  const [playingGloss, setPlayingGloss] = useState(null);
  const [manualInput, setManualInput] = useState('');
  const [errorBanner, setErrorBanner] = useState('');
  const [dataset, setDataset] = useState(readSavedDataset);
  const activeDataset = DATASETS[dataset];

  const lastTranslatedSentenceRef = useRef('');
  const lastPlayedCueRef = useRef(-1);
  const pendingSignsRef = useRef(null);
  const modelPollRef = useRef(null);
  const preParsedCuesRef = useRef([]);

  const isDetached = new URLSearchParams(window.location.search).get('detached') === '1';

  const toggleFullAvatar = useCallback((nextVal) => {
    setIsFullAvatar((prev) => {
      const next = typeof nextVal === 'boolean' ? nextVal : !prev;
      try {
        window.parent?.postMessage({ type: 'SIGNLANG_FULL_AVATAR', value: next }, '*');
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape' && isFullAvatar) {
        toggleFullAvatar(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isFullAvatar, toggleFullAvatar]);

  useEffect(() => {
    return () => {
      if (modelPollRef.current) clearInterval(modelPollRef.current);
    };
  }, []);

  useEffect(() => {
    activeDataset.dict.load().catch((err) => {
      console.error('[App] Lỗi tải từ điển:', err);
    });
  }, [activeDataset]);

  const handleToggleDataset = useCallback(() => {
    setDataset((prev) => {
      const next = prev === 'viesign' ? 'asl' : 'viesign';
      try {
        window.localStorage.setItem(DATASET_STORAGE_KEY, next);
      } catch {
        // ignore
      }
      return next;
    });
    avatarRef.current?.stopAnimation?.();
    setTranslation(null);
    lastTranslatedSentenceRef.current = '';
  }, []);

  const playOnAvatar = useCallback((signList) => {
    if (!signList?.length) return;
    const avatar = avatarRef.current;
    if (avatar?.isModelLoaded) {
      avatar.playSignSequence(signList);
      return;
    }
    pendingSignsRef.current = signList;
    if (modelPollRef.current) return;
    let attempts = 0;
    modelPollRef.current = setInterval(() => {
      attempts += 1;
      const ready = avatarRef.current;
      if (ready?.isModelLoaded) {
        clearInterval(modelPollRef.current);
        modelPollRef.current = null;
        const queued = pendingSignsRef.current;
        pendingSignsRef.current = null;
        if (queued) ready.playSignSequence(queued);
      } else if (attempts >= 120) {
        clearInterval(modelPollRef.current);
        modelPollRef.current = null;
      }
    }, 80);
  }, []);

  const handlePlayingSign = useCallback((sign) => {
    setPlayingGloss(sign?.gloss || null);
  }, []);

  // Dịch 1 câu tức thì và chỉ biểu diễn những từ có trong từ điển
  const translateAndPlay = useCallback(
    async (text, force = false) => {
      const clean = (text || '').replace(/\[.*?\]/g, '').trim();
      if (!clean) return;
      if (!force && clean === lastTranslatedSentenceRef.current) return;
      lastTranslatedSentenceRef.current = clean;

      setCurrentText(clean);
      setErrorBanner('');

      try {
        const result = await activeDataset.translate(clean);
        setTranslation(result);

        if (result.signs.length > 0) {
          playOnAvatar(result.signs);
        }
      } catch (err) {
        console.warn('[App] Lỗi dịch:', err);
      }
    },
    [playOnAvatar, activeDataset]
  );

  // Tải trước (prefetch) toàn bộ dữ liệu landmark của các câu thoại trong video để đạt độ trễ 0ms
  const prefetchVideoLandmarks = useCallback(async (cueList) => {
    await activeDataset.dict.load();
    const parsedList = [];
    const uniqueSigns = new Map();

    for (const cue of cueList) {
      const res = await activeDataset.translate(cue.text);
      parsedList.push(res);
      for (const s of res.signs) {
        if (s.found && s.gloss && !uniqueSigns.has(s.gloss)) {
          uniqueSigns.set(s.gloss, s);
        }
      }
    }

    preParsedCuesRef.current = parsedList;
    // Nạp trước các từ xuất hiện trong video vào bộ nhớ đệm của Avatar 3D
    const signsToPreload = Array.from(uniqueSigns.values());
    avatarRef.current?.preloadSigns?.(signsToPreload.slice(0, 35));
  }, [activeDataset]);

  const {
    state: speechState,
    toggle: toggleMic,
    stop: stopMic,
  } = useSpeechRecognition({
    lang: 'vi-VN',
    onFinal: ({ text }) => {
      setInterimText('');
      translateAndPlay(text, true);
    },
    onInterim: ({ text }) => {
      setInterimText(text);
    },
    onError: ({ message }) => {
      setErrorBanner(message);
    },
  });

  useEffect(() => {
    if (typeof chrome === 'undefined') return;

    const searchParams = new URLSearchParams(window.location.search);
    const paramTabId = Number(searchParams.get('tabId'));
    if (paramTabId) {
      setTargetTabId(paramTabId);
      return;
    }

    // Nếu đang chạy trong bảng nổi trên trang web (overlay=1), hỏi background lấy chính tabId hiện tại
    if (searchParams.get('overlay') === '1' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: 'GET_MY_TAB_ID' }, (res) => {
        if (res?.tabId) {
          setTargetTabId(res.tabId);
        } else if (chrome.tabs) {
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs?.[0]?.id) setTargetTabId(tabs[0].id);
          });
        }
      });
      return;
    }

    if (chrome.tabs) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const active = tabs?.[0];
        if (active?.id) {
          setTargetTabId(active.id);
        }
      });
    }
  }, []);

  const loadYouTubeCuesFromTab = useCallback(
    (tabId, force = false) => {
      if (!tabId || typeof chrome === 'undefined' || !chrome.tabs) return;
      setCaptionNotice('Đang đồng bộ lời thoại từ video YouTube...');

      chrome.tabs.sendMessage(tabId, { type: 'FETCH_YT_CUES', lang: 'vi', force }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          setCaptionNotice(
            'Mở video trên YouTube (hoặc bấm F5 lại trang YouTube) để đồng bộ tự động.'
          );
          return;
        }
        if (resp.ok && Array.isArray(resp.cues) && resp.cues.length > 0) {
          lastPlayedCueRef.current = -1;
          setCues(resp.cues);
          setCaptionNotice(
            `Đã đồng bộ & nạp sẵn ${resp.cues.length} câu thoại (${resp.language || 'vi'})`
          );
          prefetchVideoLandmarks(resp.cues);
        } else {
          setCues([]);
          setCaptionNotice(
            resp.message || 'Đang bắt lời thoại trực tiếp từ trình phát video.'
          );
        }
      });
    },
    [prefetchVideoLandmarks]
  );

  useEffect(() => {
    if (targetTabId) {
      loadYouTubeCuesFromTab(targetTabId);
    }
  }, [targetTabId, loadYouTubeCuesFromTab]);

  const cuesRef = useRef([]);
  useEffect(() => {
    cuesRef.current = cues;
  }, [cues]);

  useEffect(() => {
    if (!targetTabId || typeof chrome === 'undefined' || !chrome.tabs) return;

    const onRuntimeMessage = (msg) => {
      if (msg?.type === 'LIVE_CAPTION_UPDATE' && sourceMode === 'tab' && autoSyncVideo) {
        if (msg.state) {
          setVideoState((prev) => ({
            ...prev,
            ...msg.state,
            currentTime: Math.floor(msg.state.currentTime),
          }));
        }
        if (cuesRef.current.length === 0 && msg.text) {
          translateAndPlay(msg.text);
        }
      }
    };

    chrome.runtime.onMessage?.addListener(onRuntimeMessage);

    const timer = setInterval(() => {
      chrome.tabs.sendMessage(targetTabId, { type: 'GET_VIDEO_STATE' }, (state) => {
        if (chrome.runtime.lastError || !state) return;

        setVideoState((prev) => {
          const sameSec = Math.floor(prev.currentTime) === Math.floor(state.currentTime);
          if (
            sameSec &&
            prev.paused === state.paused &&
            prev.hasVideo === state.hasVideo &&
            prev.title === state.title
          ) {
            return prev;
          }
          return state;
        });

        if (sourceMode === 'tab' && autoSyncVideo && state.hasVideo) {
          const list = cuesRef.current;
          if (list.length > 0) {
            // Dịch sớm hơn 0.45s và nạp trước các câu tiếp theo để tốc độ phản hồi là tức thì
            const idx = findCueIndex(list, state.currentTime + 0.45);
            if (idx !== -1 && idx !== lastPlayedCueRef.current) {
              lastPlayedCueRef.current = idx;
              setActiveCueIdx(idx);
              translateAndPlay(list[idx].text, true);

              // Nạp trước 2 câu kế tiếp vào bộ nhớ đệm
              const next1 = preParsedCuesRef.current[idx + 1];
              const next2 = preParsedCuesRef.current[idx + 2];
              if (next1?.signs?.length) avatarRef.current?.preloadSigns?.(next1.signs);
              if (next2?.signs?.length) avatarRef.current?.preloadSigns?.(next2.signs);
            }
          } else if (!state.paused && state.liveCaption) {
            translateAndPlay(state.liveCaption);
          }
        }
      });
    }, 180);

    return () => {
      clearInterval(timer);
      chrome.runtime.onMessage?.removeListener(onRuntimeMessage);
    };
  }, [targetTabId, sourceMode, autoSyncVideo, translateAndPlay]);

  useEffect(() => {
    if (showCueList && activeCueItemRef.current) {
      activeCueItemRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeCueIdx, showCueList]);

  const handleSelectMode = (mode) => {
    setSourceMode(mode);
    setErrorBanner('');
    if (mode === 'tab') {
      stopMic();
      if (targetTabId) {
        chrome.tabs?.sendMessage(targetTabId, { type: 'ENABLE_YT_CC' }, () => {});
        loadYouTubeCuesFromTab(targetTabId);
      }
    }
  };

  const handleCueItemClick = (cue, idx) => {
    lastPlayedCueRef.current = idx;
    setActiveCueIdx(idx);
    translateAndPlay(cue.text, true);
    if (targetTabId && typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.sendMessage(targetTabId, { type: 'SEEK_VIDEO', time: cue.start }, () => {});
    }
  };

  const handleRequestMicPermissionTab = () => {
    if (typeof chrome !== 'undefined' && chrome.tabs) {
      chrome.tabs.create({ url: chrome.runtime.getURL('popup.html?detached=1') });
    }
  };

  const handleOpenDetachedWindow = () => {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({
        type: 'OPEN_DETACHED_WINDOW',
        tabId: targetTabId,
      });
    }
  };

  const handleTogglePlayTabVideo = () => {
    if (!targetTabId || typeof chrome === 'undefined' || !chrome.tabs) return;
    chrome.tabs.sendMessage(targetTabId, { type: 'TOGGLE_PLAY_VIDEO' }, (state) => {
      if (!chrome.runtime.lastError && state) setVideoState(state);
    });
  };

  const handleManualSubmit = (e) => {
    e.preventDefault();
    const text = manualInput.trim();
    if (!text) return;
    translateAndPlay(text, true);
    setManualInput('');
  };

  return (
    <div className={`ext-container ${isFullAvatar ? 'full-avatar-mode' : ''}`}>
      {/* Top Header & Contact/Status Bar */}
      <header className="ext-header">
        <div className="ext-brand">
          <div className="ext-logo-badge">3D</div>
          <div>
            <h1 className="ext-title">SignLang Studio</h1>
            <p className="ext-subtitle">Âm thanh & Video → Ngôn ngữ ký hiệu</p>
          </div>
        </div>

        <div className="ext-header-actions">
          <button
            type="button"
            className={`ext-icon-btn ${dataset === 'viesign' ? 'active' : ''}`}
            style={{ width: 'auto', padding: '0 10px', fontSize: '11px', fontWeight: 700 }}
            title={`Bộ dữ liệu: ${activeDataset.title} — bấm để đổi`}
            onClick={handleToggleDataset}
          >
            {activeDataset.label}
          </button>

          <span className="ext-moss-badge">
            <span className="ext-moss-dot" />
            {videoState.hasVideo && !videoState.paused ? 'Live Syncing' : 'Ready'}
          </span>

          <button
            type="button"
            className={`ext-icon-btn ${isFullAvatar ? 'active' : ''}`}
            title="Chế độ Full màn hình nhân vật 3D (chỉ hiện nhân vật 3D, ẩn mọi thành phần khác)"
            onClick={() => toggleFullAvatar(true)}
          >
            <Maximize2 size={15} />
          </button>

          {!isDetached && (
            <button
              type="button"
              className="ext-icon-btn"
              title="Tách thành cửa sổ nổi (không bị đóng khi bấm vào YouTube)"
              onClick={handleOpenDetachedWindow}
            >
              <ExternalLink size={15} />
            </button>
          )}
        </div>
      </header>

      {/* Khung mô hình 3D (bo góc 12px với viền nâu ấm, hoặc Full màn hình khi bật isFullAvatar) */}
      <div className="ext-stage-wrapper">
        <AvatarScene3D
          ref={avatarRef}
          minimalUI={isFullAvatar}
          onPlayingSign={handlePlayingSign}
        />

        <button
          type="button"
          className={`ext-fullscreen-floating-btn ${isFullAvatar ? 'in-full' : ''}`}
          title={
            isFullAvatar
              ? 'Thoát chế độ Full màn hình 3D (hoặc nhấn phím Esc)'
              : 'Phóng to Full màn hình chỉ hiện nhân vật 3D'
          }
          onClick={() => toggleFullAvatar()}
        >
          {isFullAvatar ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>

        {!isFullAvatar && translation?.signs?.length > 0 && (
          <button
            type="button"
            className="ext-replay-floating-btn"
            title="Biểu diễn lại câu này"
            onClick={() => translateAndPlay(currentText, true)}
          >
            <RotateCcw size={14} />
          </button>
        )}
      </div>

      {/* Thanh điều khiển theo chế độ */}
      {sourceMode === 'tab' ? (
        <div className="ext-control-card">
          <div className="ext-video-status-row">
            <div className="ext-video-info">
              <span
                className={`ext-status-dot ${
                  videoState.hasVideo && !videoState.paused ? 'live' : ''
                }`}
              />
              <span className="ext-video-title" title={videoState.title}>
                {videoState.hasVideo
                  ? videoState.title || 'Video đang mở trên Tab'
                  : 'Chưa phát hiện video trên tab hiện tại'}
              </span>
            </div>

            {videoState.hasVideo && (
              <div className="ext-video-controls">
                <span className="ext-time-badge">
                  {formatTime(videoState.currentTime)} / {formatTime(videoState.duration)}
                </span>
                <button
                  type="button"
                  className="ext-mini-btn"
                  onClick={handleTogglePlayTabVideo}
                  title={videoState.paused ? 'Phát video' : 'Tạm dừng video'}
                >
                  {videoState.paused ? <Play size={13} /> : <Pause size={13} />}
                </button>
              </div>
            )}
          </div>

          <div className="ext-sync-actions">
            <button
              type="button"
              className={`btn ext-primary-btn ${autoSyncVideo ? 'listening' : ''}`}
              onClick={() => setAutoSyncVideo((v) => !v)}
            >
              <Volume2 size={15} />
              <span>
                {autoSyncVideo ? 'Đang tự động dịch theo Video' : 'Bật tự động dịch Video'}
              </span>
            </button>

            {cues.length > 0 && (
              <button
                type="button"
                className={`ext-secondary-btn ${showCueList ? 'active' : ''}`}
                title="Xem danh sách câu thoại trong video"
                onClick={() => setShowCueList((v) => !v)}
              >
                <ListMusic size={14} />
                <span>{cues.length} câu</span>
              </button>
            )}

            <button
              type="button"
              className="ext-secondary-btn"
              title="Đồng bộ lại phụ đề từ YouTube"
              onClick={() => {
                if (targetTabId) {
                  chrome.tabs?.sendMessage(targetTabId, { type: 'ENABLE_YT_CC' }, () => {});
                  loadYouTubeCuesFromTab(targetTabId, true);
                }
              }}
            >
              <Subtitles size={14} />
            </button>
          </div>

          {captionNotice && <p className="ext-caption-hint">{captionNotice}</p>}

          {showCueList && cues.length > 0 && (
            <div className="ext-cue-list">
              {cues.map((cue, idx) => (
                <button
                  key={`${cue.start}-${idx}`}
                  ref={idx === activeCueIdx ? activeCueItemRef : null}
                  type="button"
                  className={`ext-cue-item ${idx === activeCueIdx ? 'active' : ''}`}
                  onClick={() => handleCueItemClick(cue, idx)}
                >
                  <span className="ext-cue-time">{formatTime(cue.start)}</span>
                  <span className="ext-cue-text">{cue.text}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="ext-control-card">
          <div className="ext-mic-row">
            <button
              type="button"
              className={`btn ext-primary-btn ${speechState === 'listening' ? 'recording' : ''}`}
              onClick={toggleMic}
            >
              {speechState === 'listening' ? <MicOff size={15} /> : <Mic size={15} />}
              <span>
                {speechState === 'listening'
                  ? 'Đang nghe âm thanh... (Bấm để dừng)'
                  : 'Bắt đầu thu âm & dịch sang 3D'}
              </span>
            </button>
          </div>
          {errorBanner && (
            <div className="ext-error-box">
              <span>{errorBanner}</span>
              {!isDetached && (
                <button
                  type="button"
                  className="btn ext-link-btn"
                  onClick={handleRequestMicPermissionTab}
                >
                  Cấp quyền Mic
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Khung hiển thị câu đang nghe & các từ khóa có trong từ điển (Đã lược bỏ hoàn toàn từ ngoài từ điển) */}
      <div className="ext-transcript-card">
        <div className="ext-transcript-header">
          <span className="ext-section-label">LỜI THOẠI & TỪ KHÓA TRONG TỪ ĐIỂN</span>
          {translation?.signs?.length > 0 && (
            <span className="ext-match-badge">{translation.signs.length} ký hiệu 3D</span>
          )}
        </div>

        <div className="ext-transcript-text">
          {interimText ? (
            <span className="ext-interim">{interimText}...</span>
          ) : currentText ? (
            <span>“{currentText}”</span>
          ) : (
            <span className="ext-placeholder">
              Mở video YouTube hoặc chọn câu mẫu bên dưới để xem nhân vật 3D biểu diễn...
            </span>
          )}
        </div>

        {translation?.signs?.length > 0 && (
          <div className="ext-gloss-chips">
            {translation.signs.map((sign, idx) => {
              const isPlaying =
                playingGloss &&
                sign.gloss &&
                playingGloss.toLowerCase() === sign.gloss.toLowerCase();
              return (
                <button
                  key={`${sign.vi}-${idx}`}
                  type="button"
                  className={`ext-gloss-chip ${isPlaying ? 'active' : ''}`}
                  onClick={() => playOnAvatar([sign])}
                  title={`Bấm để xem động tác: ${sign.vi} (${sign.gloss})`}
                >
                  <span className="chip-vi">{sign.vi}</span>
                  <span className="chip-en">
                    {sign.language ? sign.language.toUpperCase() : sign.gloss}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Thanh nhập văn bản thủ công & các thẻ tag câu mẫu */}
      <form className="ext-input-bar" onSubmit={handleManualSubmit}>
        <input
          type="text"
          className="ext-text-input"
          placeholder="Nhập câu tiếng Việt rồi nhấn Enter (tự bỏ qua từ ngoài từ điển)..."
          value={manualInput}
          onChange={(e) => setManualInput(e.target.value)}
        />
        <button type="submit" className="btn ext-send-btn" title="Dịch sang ký hiệu 3D">
          <Send size={14} />
        </button>
      </form>

      <div className="ext-samples-row">
        {SAMPLE_SENTENCES.map((sample) => (
          <button
            key={sample}
            type="button"
            className="ext-sample-pill"
            onClick={() => translateAndPlay(sample, true)}
          >
            {sample}
          </button>
        ))}
      </div>

      {/* Floating Bottom Navigation Pill (Thanh điều hướng viên thuốc bo tròn 60px ở đáy) */}
      <nav className="ext-floating-nav" aria-label="Chế độ phiên dịch">
        <button
          type="button"
          className={`ext-nav-pill-item ${sourceMode === 'tab' ? 'active' : ''}`}
          onClick={() => handleSelectMode('tab')}
        >
          <Tv size={14} />
          <span>Video YouTube</span>
        </button>
        <button
          type="button"
          className={`ext-nav-pill-item ${sourceMode === 'mic' ? 'active' : ''}`}
          onClick={() => handleSelectMode('mic')}
        >
          <Mic size={14} />
          <span>Thu âm trực tiếp</span>
        </button>
      </nav>
    </div>
  );
}
