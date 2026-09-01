'use client';
// 이미지 라이트박스 — 클릭 확대 보기 (배경 클릭/✕/ESC 닫기, 여러 장이면 ‹ › · 방향키 이동)
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useBlobUrl } from '@/lib/blobStore';

export function Lightbox({ srcs, index, onClose }: {
  srcs: string[];              // IndexedDB 파일 id 또는 URL 혼용 가능
  index: number;
  onClose: () => void;
}) {
  const [i, setI] = useState(index);
  useEffect(() => setI(index), [index]);
  // 등록 폼에서 방금 고른 파일은 이번 세션에서 만든 blob: 주소다.
  // useBlobUrl은 blob:을 (새로고침으로 죽은) 옛 참조로 보고 거부하므로 여기서는 그대로 쓴다.
  const raw = srcs[i] ?? '';
  const live = raw.startsWith('blob:');
  const loaded = useBlobUrl(live ? undefined : raw);
  const url = live ? raw : loaded;

  useEffect(() => {
    const before = document.body.style.overflow;
    const appMain = document.getElementById('appMain');
    const beforeInert = appMain?.inert ?? false;
    document.body.style.overflow = 'hidden';
    if (appMain) appMain.inert = true;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft' && srcs.length > 1) setI(x => (x - 1 + srcs.length) % srcs.length);
      if (e.key === 'ArrowRight' && srcs.length > 1) setI(x => (x + 1) % srcs.length);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = before;
      if (appMain) appMain.inert = beforeInert;
    };
  }, [srcs.length, onClose]);

  return createPortal(
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="이미지 크게 보기" onClick={onClose}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      {url && <img src={url} alt={`확대 이미지 ${i + 1}`} onClick={e => e.stopPropagation()} />}
      {srcs.length > 1 && (
        <>
          <button className="nv l" aria-label="이전 이미지" onClick={e => { e.stopPropagation(); setI(x => (x - 1 + srcs.length) % srcs.length); }}>‹</button>
          <button className="nv r" aria-label="다음 이미지" onClick={e => { e.stopPropagation(); setI(x => (x + 1) % srcs.length); }}>›</button>
          <span className="cnt">{i + 1} / {srcs.length}</span>
        </>
      )}
      <button className="x" aria-label="확대 이미지 닫기" onClick={e => { e.stopPropagation(); onClose(); }}>✕</button>
    </div>,
    document.body,
  );
}
