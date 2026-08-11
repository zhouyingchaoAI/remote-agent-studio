import { useRef, useState, useCallback } from 'react';

/**
 * 麦克风录音 + 云端转写 hook。
 * 录音用浏览器 MediaRecorder(Electron Chromium 支持),停止后把音频交给主进程转写。
 * 返回 { state, error, start, stop, toggle } —— state: 'idle'|'recording'|'transcribing'
 */
export function useVoiceInput(onText) {
  const [state, setState] = useState('idle');
  const [error, setError] = useState('');
  const mediaRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);

  const cleanup = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    mediaRef.current = null;
    chunksRef.current = [];
  };

  const start = useCallback(async () => {
    setError('');
    if (state !== 'idle') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => { if (e.data && e.data.size) chunksRef.current.push(e.data); };
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        cleanup();
        if (!blob.size) { setState('idle'); return; }
        setState('transcribing');
        try {
          const buf = await blob.arrayBuffer();
          const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
          const { text } = await window.api.stt.transcribe({
            audioBase64: b64, mimeType: rec.mimeType || 'audio/webm', filename: 'speech.webm'
          });
          if (text && onText) onText(text);
          else if (!text) setError('没听清,请重试');
        } catch (e) {
          setError(e?.message || '转写失败');
        } finally {
          setState('idle');
        }
      };
      rec.start();
      mediaRef.current = rec;
      setState('recording');
    } catch (e) {
      cleanup();
      setState('idle');
      setError(e?.name === 'NotAllowedError' ? '麦克风权限被拒绝' : (e?.message || '无法访问麦克风'));
    }
  }, [state, onText]);

  const stop = useCallback(() => {
    if (mediaRef.current && state === 'recording') {
      try { mediaRef.current.stop(); } catch (_) { cleanup(); setState('idle'); }
    }
  }, [state]);

  const toggle = useCallback(() => {
    if (state === 'recording') stop(); else if (state === 'idle') start();
  }, [state, start, stop]);

  return { state, error, start, stop, toggle };
}
