/**
 * useSpeechRecognition.js
 * Hook nhận diện giọng nói trực tiếp bằng Web Speech API (kèm bộ lọc nhiễu từ noise-filter.js)
 * chạy hoàn toàn trên trình duyệt Chrome mà không cần Backend Python.
 */

import { useState, useRef, useCallback, useEffect } from 'react';

const CONFIDENCE_THRESHOLD = 0.55;
const MIN_TEXT_LENGTH = 2;
const DEDUP_WINDOW_MS = 500;
const RESTART_DELAY_MS = 250;

function getSpeechRecognition() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export default function useSpeechRecognition({
  lang = 'vi-VN',
  onFinal,
  onInterim,
  onError,
} = {}) {
  const [state, setState] = useState('idle'); // idle | listening | error
  const [isSupported] = useState(() => !!getSpeechRecognition());

  const recognitionRef = useRef(null);
  const wantListeningRef = useRef(false);
  const restartTimerRef = useRef(null);
  const lastFinalRef = useRef({ text: '', time: 0 });
  const callbacksRef = useRef({ onFinal, onInterim, onError });
  const langRef = useRef(lang);

  useEffect(() => {
    callbacksRef.current = { onFinal, onInterim, onError };
  }, [onFinal, onInterim, onError]);

  useEffect(() => {
    langRef.current = lang;
  }, [lang]);

  const stop = useCallback(() => {
    wantListeningRef.current = false;
    clearTimeout(restartTimerRef.current);
    const rec = recognitionRef.current;
    recognitionRef.current = null;
    if (rec) {
      rec.onstart = null;
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.stop();
      } catch {
        // ignore
      }
    }
    setState('idle');
    callbacksRef.current.onInterim?.({ text: '' });
  }, []);

  const startSession = useCallback(() => {
    const SpeechRec = getSpeechRecognition();
    if (!SpeechRec) {
      setState('error');
      callbacksRef.current.onError?.({
        code: 'unsupported',
        message: 'Trình duyệt không hỗ trợ Web Speech API.',
      });
      return;
    }

    const rec = new SpeechRec();
    rec.lang = langRef.current;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      setState('listening');
    };

    rec.onresult = (event) => {
      let interimTranscript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = (result[0]?.transcript || '').trim();
        const confidence = typeof result[0]?.confidence === 'number' ? result[0].confidence : 0;

        if (!transcript || transcript.length < MIN_TEXT_LENGTH) continue;

        if (result.isFinal) {
          if (confidence > 0 && confidence < CONFIDENCE_THRESHOLD) continue;

          const now = Date.now();
          if (
            transcript === lastFinalRef.current.text &&
            now - lastFinalRef.current.time < DEDUP_WINDOW_MS
          ) {
            continue;
          }
          lastFinalRef.current = { text: transcript, time: now };
          callbacksRef.current.onInterim?.({ text: '' });
          callbacksRef.current.onFinal?.({ text: transcript, confidence });
        } else {
          interimTranscript += (interimTranscript ? ' ' : '') + transcript;
        }
      }

      if (interimTranscript) {
        callbacksRef.current.onInterim?.({ text: interimTranscript });
      }
    };

    rec.onerror = (event) => {
      const code = event.error;
      if (code === 'no-speech' || code === 'aborted') return;

      if (code === 'not-allowed' || code === 'service-not-allowed') {
        wantListeningRef.current = false;
        setState('error');
        // Trong Chrome Extension Popup, nếu chưa cấp quyền mic thì có thể mở tab cấp quyền
        callbacksRef.current.onError?.({
          code,
          message:
            'Chưa cấp quyền thu âm (Microphone). Nhấn nút "Cấp quyền Mic" bên dưới hoặc bật trong cài đặt Chrome.',
        });
        return;
      }

      callbacksRef.current.onError?.({
        code,
        message: `Lỗi nhận diện âm thanh (${code}).`,
      });
    };

    rec.onend = () => {
      if (wantListeningRef.current) {
        clearTimeout(restartTimerRef.current);
        restartTimerRef.current = setTimeout(() => {
          if (wantListeningRef.current) startSession();
        }, RESTART_DELAY_MS);
      } else {
        setState('idle');
      }
    };

    recognitionRef.current = rec;
    try {
      rec.start();
    } catch (err) {
      setState('error');
      callbacksRef.current.onError?.({
        code: 'start-failed',
        message: 'Không thể khởi động bộ thu âm thanh.',
      });
    }
  }, []);

  const start = useCallback(() => {
    wantListeningRef.current = true;
    startSession();
  }, [startSession]);

  const toggle = useCallback(() => {
    if (wantListeningRef.current || state === 'listening') {
      stop();
    } else {
      start();
    }
  }, [state, start, stop]);

  useEffect(() => {
    return () => {
      wantListeningRef.current = false;
      clearTimeout(restartTimerRef.current);
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  return {
    state,
    isSupported,
    start,
    stop,
    toggle,
  };
}

