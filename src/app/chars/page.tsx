'use client';
// EditableDesc 주입
// 캐릭터 리스트 (4.4) — 한 줄 5개 · 3:4 썸네일(크롭 반영) · 전용 폰트 · ＋ ADD CHARACTER
import React, { Suspense, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useLocalList } from '@/lib/postStore';
import { Character, CHAR_SEED, charThumbRef } from '@/lib/charStore';
import { useSectionParam, filterSection, sectionSetter, secQuery } from '@/lib/sectionStore';
import { SearchBar, FitText } from '@/components/ui/Kit';
import { CroppedBlobImg } from '@/components/ui/CropEditor';

import { useToast } from '@/components/ui/Toast';
import { EditableDesc, PageTitle } from '@/components/ui/PageText';
import { useMainStore } from '@/lib/mainStore';
import { useCardSort, mergeOrder } from '@/lib/cardSort';

function CharsInner() {
  const router = useRouter();
  const { isAdmin } = useAuth();
  const toast = useToast();
  const { editOn } = useMainStore();
  const [charsAll, setCharsAll] = useLocalList<Character>('ohome.chars.v1', CHAR_SEED);
  // 여러 개로 만든 캐릭터 목록 (v2.0 사용자 요청) — 주소의 ?s= 가 가리키는 것만
  const sec = useSectionParam('chars');
  const chars = filterSection(charsAll, sec.id);
  // 저장은 이 목록 자리만 교체 — 걸러진 목록을 그대로 넘겨도 다른 목록이 지워지지 않는다
  const setChars = sectionSetter(charsAll, sec.id, setCharsAll);
  const [q, setQ] = useState('');

  const visible = chars
    .filter(c => c.own)
    .filter(c => isAdmin || c.visibility === 'public')
    .filter(c => !q || c.name.toLowerCase().includes(q.toLowerCase()) || c.sub.includes(q));

  // 편집모드 카드 드래그 정렬 (v1.9)
  const sort = useCardSort(visible, next => setChars(mergeOrder(chars, next)), editOn && isAdmin);

  return (
    <section className="page chars-page">
      <div className="page-head chars-archive-head">
        <div className="chars-archive-title">
          <PageTitle>{sec.id === 'main' ? 'CHARACTER' : sec.name}</PageTitle>
          <EditableDesc k="chars-desc" def="운영자의 자캐 목록 · 클릭 시 프로필로 이동" />
        </div>
        <div className="head-actions chars-archive-actions">
          <SearchBar onSearch={setQ} />
          {isAdmin && <button className="btn btn-dark" onClick={() => router.push('/chars/new' + secQuery(sec.id))}>＋ ADD CHARACTER</button>}
        </div>
      </div>

      <div className="chars-grid">
        {visible.map((c, i) => {
          const priv = c.visibility === 'private';
          const sp = sort(i) as { style?: React.CSSProperties };
          return (
            <div key={c.id} className="char-card char-archive-card" {...sort(i)}
              style={{ ...(priv ? { opacity: .45 } : undefined), ...sp.style }}
              onClick={() => { if (!editOn) router.push(`/chars/${c.id}`); }}>
              <div className="thumb">
                <CroppedBlobImg fileRef={charThumbRef(c)} crop={c.thumbCrop} ph={c.thumbClass}
                  label={priv ? '비공개' : '3:4'} />
                <div className="char-archive-shade" aria-hidden="true" />
                <div className="char-archive-name">
                  <b><FitText>{c.name}</FitText></b>
                  {c.sub?.trim() && <small>{c.sub}</small>}
                </div>
              </div>
            </div>
          );
        })}
        {visible.length === 0 && (
          <p className="chars-empty">
            표시할 캐릭터가 없습니다
          </p>
        )}
      </div>
    </section>
  );
}

export default function CharsPage() {
  // useSearchParams는 Suspense 경계 필요 (Next App Router)
  return <Suspense fallback={<section className="page" />}><CharsInner /></Suspense>;
}
