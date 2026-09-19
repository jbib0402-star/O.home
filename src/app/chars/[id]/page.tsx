'use client';
// 캐릭터 프로필 상세 (4.4) — 좌측 아이콘 탭 · 중앙 스티키 아트 · 우측 정보 패널
// 스크롤: 정보가 길면 페이지가 이어지고 탭·아트는 스티키 (v1.9)
// AU 선택 시 프로필 전체(이름·스펙·아트·탭·소개)가 그 AU의 값으로 전환 (charWithAu) —
// 편집은 EDIT → /chars/[id]/edit?au= 전용 페이지에서 새 프로필처럼 작성 (v1.9 사용자 확정)
import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { newId, useLocalList } from '@/lib/postStore';
import {
  AuCharProfile, Character, CHAR_AU_PREFIX, CHAR_SEED, charGrant, charThumbRef, charWithAu,
  chipBorder, isCharacterAuKey, Relation, REL_SEED, characterWorkStatusMeta,
} from '@/lib/charStore';
import { sanitizeHtml } from '@/lib/sanitize';
import { useFonts } from '@/lib/fontStore';
import { useTheme } from '@/lib/ThemeProvider';
import { createPortal } from 'react-dom';
import { useBlobUrl } from '@/lib/blobStore';
import { CroppedBlobImg, CropEditor, type CropValue } from '@/components/ui/CropEditor';

import { PageTitle } from '@/components/ui/PageText';
import { ConfirmModal, Modal } from '@/components/ui/Modal';
import { KInput } from '@/components/ui/Kit';

type CharAuChoice = {
  key: string;
  label: string;
  source: 'character' | 'relation';
  relName?: string;
};

/** 캐릭터 자체 AU 생성 직후의 독립 프로필. 이미지는 비워 ORIGINAL을 자동 상속하지 않는다. */
function blankCharacterAu(label: string, base: Character): AuCharProfile {
  return {
    label,
    source: 'character',
    name: '',
    altName: '',
    sub: '',
    quote: '',
    workStatus: null,
    workStatusCustom: undefined,
    basicHtml: '',
    tabs: [],
    specs: [{ label: '성별', value: '' }, { label: '키', value: '' }],
    color: base.color,
    themeMode: 'default',
    colors: [],
    colorTipMode: 'hex',
    outfits: [],
    arts: [],
    thumbId: undefined,
    thumbCrop: undefined,
    artCrop: undefined,
    fontId: base.fontId ?? 'serif',
    nameSize: base.nameSize ?? 38,
    bodyFontId: base.bodyFontId ?? 'default',
  };
}

/** 상세 전신 기본 표시 — 크롭 없이 원본 비율과 투명 배경을 유지하며 영역 안에 전부 맞춘다. */
function FullArtBlobImg({ fileRef, ph, label, alt }: {
  fileRef?: string; ph?: string; label?: string; alt?: string;
}) {
  const url = useBlobUrl(fileRef);
  if (!url) {
    return <div className={`ph ${ph ?? ''}`} style={{ width: '100%', height: '100%' }}>{label && <span>{label}</span>}</div>;
  }
  return (
    <div className="profile-art-contain">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={alt ?? ''} draggable={false} />
    </div>
  );
}

function CharDetailInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, isAdmin } = useAuth();
  const [chars, setChars, loaded] = useLocalList<Character>('ohome.chars.v1', CHAR_SEED);
  const [rels] = useLocalList<Relation>('ohome.rels.v1', REL_SEED);
  const { familyOf } = useFonts();
  const params = useSearchParams();
  const [tab, setTab] = useState('basic');
  const [artIdx, setArtIdx] = useState(0);
  const [delAsk, setDelAsk] = useState(false);   // 캐릭터 삭제 확인
  const [auCreateOpen, setAuCreateOpen] = useState(false);
  const [auCreateName, setAuCreateName] = useState('');
  const [auDelAsk, setAuDelAsk] = useState<string | null>(null);
  const infoRef = useRef<HTMLDivElement>(null);

  const ch = chars.find(c => c.id === id);

  // 캐릭터 자체 AU와 자관 AU를 함께 표시하되 namespace/source를 분리해 충돌을 막는다.
  const charAus = useMemo<CharAuChoice[]>(() => {
    if (!ch) return [];
    const own = Object.entries(ch.auProfiles ?? {})
      .filter(([key, p]) => isCharacterAuKey(key) || p.source === 'character')
      .map(([key, p]) => ({ key, label: p.label?.trim() || 'AU', source: 'character' as const }));
    const relation = rels.flatMap(r => r.members.some(m => m.charId === ch.id)
      ? r.aus.filter(a => a.id !== 'base').map(a => ({
        key: `${r.id}:${a.id}`, label: a.label, relName: r.name, source: 'relation' as const,
      }))
      : []);
    return [...own, ...relation];
  }, [rels, ch]);
  // AU 편집에서 ?au= 로 돌아오면 그 AU가 선택된 채 시작
  const [auKey, setAuKey] = useState<string | null>(() => params.get('au'));
  const canEdit = !!ch && (isAdmin || charGrant(ch, user?.id) === 'edit');
  // 대표 아트 우클릭 → 상세 화면에 보일 위치 조정 (v2.0)
  const [artCtx, setArtCtx] = useState<{ x: number; y: number; ref: string } | null>(null);
  // 편집 중인 아트 참조 + 그때 실제 표시 영역의 가로/세로 비 (3:4가 아니라 화면 높이에 따라 달라진다)
  const [artCropOpen, setArtCropOpen] = useState<{ ref: string; ratio: number } | null>(null);
  const artBoxRef = useRef<HTMLDivElement>(null);
  const artBoxRatio = () => {
    const r = artBoxRef.current?.getBoundingClientRect();
    return r && r.height > 1 ? r.width / r.height : 3 / 4;
  };
  useEffect(() => {
    if (!artCtx) return;
    const close = () => setArtCtx(null);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setArtCtx(null); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', key); };
  }, [artCtx]);
  // AU는 "새로 등록"하는 프로필 (v1.9 사용자 확정) — 등록 전엔 base를 보여주지 않고 등록 안내
  const auRegistered = !auKey || !!ch?.auProfiles?.[auKey];
  // 표시용 캐릭터 — AU에서 지정한 필드만 base를 대체 (이름·키·성별부터 전부 바뀔 수 있음)
  const eff = ch ? charWithAu(ch, auKey) : undefined;
  const workStatusMeta = eff ? characterWorkStatusMeta(eff.workStatus, eff.workStatusCustom) : null;

  /** 상세 화면 아트 위치 저장 (v2.0) — AU를 보는 중이면 그 AU에만, 아니면 원본에 */
  const saveArtCrop = (c: CropValue | undefined) => {
    setChars(chars.map(x => {
      if (x.id !== id) return x;
      if (!auKey) return { ...x, artCrop: c };
      return { ...x, auProfiles: { ...x.auProfiles, [auKey]: { ...x.auProfiles?.[auKey], artCrop: c } } };
    }));
  };

  const createCharacterAu = () => {
    const label = auCreateName.trim();
    if (!ch || !label || !canEdit) return;
    const key = `${CHAR_AU_PREFIX}${newId()}`;
    setChars(chars.map(x => (x.id === ch.id ? {
      ...x,
      auProfiles: { ...x.auProfiles, [key]: blankCharacterAu(label, x) },
    } : x)));
    setAuCreateOpen(false);
    setAuCreateName('');
    // 서버 저장보다 편집 페이지 이동이 먼저 끝나도 사용자가 입력한 AU 이름을 잃지 않게
    // 생성 시점의 label을 함께 전달한다. 편집 페이지는 저장된 프로필 label을 우선한다.
    router.push(`/chars/${ch.id}/edit?au=${encodeURIComponent(key)}&aulabel=${encodeURIComponent(label)}`);
  };

  const deleteCharacterAu = (key: string) => {
    if (!ch || !isCharacterAuKey(key) || !canEdit) return;
    setChars(chars.map(x => {
      if (x.id !== ch.id) return x;
      const nextProfiles = { ...(x.auProfiles ?? {}) };
      delete nextProfiles[key];
      return { ...x, auProfiles: Object.keys(nextProfiles).length ? nextProfiles : undefined };
    }));
    setAuDelAsk(null);
    setAuKey(null);
    router.replace(`/chars/${ch.id}`);
  };

  // AU 전환 시 탭 구성·아트가 달라지므로 리셋
  useEffect(() => { setTab('basic'); setArtIdx(0); }, [auKey]);

  // 캐릭터 테마색 → 페이지 임시 테마 (4.18 방식, v1.9) — 「캐릭터 테마색」 선택 시에만, 벗어나면 원복
  const { setPageTheme } = useTheme();
  const pageColor = auRegistered && eff?.themeMode === 'custom' ? eff.color : null;
  useEffect(() => {
    setPageTheme(pageColor);
    return () => setPageTheme(null);
  }, [pageColor, setPageTheme]);

  // 비공개 추가 탭은 관리자·캐릭터 편집 권한자만 탐색하거나 내용을 열 수 있다.
  // 기존 탭은 visibility가 없으므로 공개로 간주한다.
  const visibleTabs = useMemo(
    () => eff?.tabs.filter(t => t.visibility !== 'private' || canEdit) ?? [],
    [eff?.tabs, canEdit],
  );
  const curTab = visibleTabs.find(t => t.id === tab);
  const tabHtml = useMemo(
    () => (loaded && curTab ? sanitizeHtml(curTab.html) : ''),
    [loaded, curTab],
  );
  const basicHtml = useMemo(
    () => (loaded && eff ? sanitizeHtml(eff.basicHtml) : ''),
    [loaded, eff],
  );

  if (!loaded) return <section className="page" />;
  if (!ch || !eff) {
    return (
      <section className="page">
        <div className="page-head"><PageTitle>CHARACTERS</PageTitle><p>캐릭터를 찾을 수 없습니다</p></div>
      </section>
    );
  }
  if (ch.visibility === 'private' && !isAdmin) {
    return (
      <section className="page">
        <div className="page-head"><PageTitle>CHARACTERS</PageTitle><p>비공개 캐릭터입니다</p></div>
      </section>
    );
  }
  if (ch.visibility === 'member' && !user) {
    return (
      <section className="page">
        <div className="page-head"><PageTitle>CHARACTERS</PageTitle><p>멤버공개 — 로그인 후 열람할 수 있습니다</p></div>
      </section>
    );
  }

  // 탭 전환 시 정보 상단이 화면 맨 위로 오도록 스크롤 (모바일형, v1.9)
  const pickTab = (t: string) => {
    setTab(t);
    if (window.matchMedia('(max-width:960px)').matches) {
      infoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  const editHref = auKey ? `/chars/${ch.id}/edit?au=${encodeURIComponent(auKey)}` : `/chars/${ch.id}/edit`;
  // 대표 전신은 항상 첫 「기본」 탭으로 유지하고, 별도로 추가한 의상 전신만 그 옆에 붙인다.
  // 기존 arts의 2장째 이후는 '추가 아트'이므로 의상 버튼으로 만들지 않는다.
  const legacyArts = eff.arts && eff.arts.length > 0
    ? eff.arts
    : eff.artId ? [eff.artId] : eff.artUrl ? [eff.artUrl] : [];
  const baseFullArt = legacyArts[0];
  const outfitChoices = [
    ...(baseFullArt ? [{ id: 'base', label: '기본', imgId: baseFullArt }] : []),
    ...(eff.outfits ?? []),
  ];
  const activeOutfitIdx = outfitChoices.length > 0 ? Math.min(artIdx, outfitChoices.length - 1) : 0;
  const activeOutfit = outfitChoices[activeOutfitIdx];
  const showingBaseFullArt = activeOutfit?.id === 'base';

  return (
    <section className="page-char-detail">
      <ConfirmModal open={delAsk} title="캐릭터를 삭제하시겠습니까?"
        body="프로필·탭 정보가 함께 삭제되며 복구할 수 없습니다. 이 캐릭터가 들어간 자관에서는 멤버 표시가 사라집니다."
        onClose={() => setDelAsk(false)}
        buttons={[
          { label: 'DELETE', kind: 'accent', onClick: () => { setChars(chars.filter(c => c.id !== ch.id)); router.push('/chars'); } },
          { label: 'CANCEL', kind: 'ghost', onClick: () => setDelAsk(false) },
        ]} />
      <Modal open={auCreateOpen} small title="새 AU 프로필"
        desc="AU 이름을 입력하면 독립된 프로필을 만든 뒤 바로 편집 화면으로 이동합니다."
        onClose={() => { setAuCreateOpen(false); setAuCreateName(''); }}
        actions={<>
          <button className="btn btn-ghost" onClick={() => { setAuCreateOpen(false); setAuCreateName(''); }}>CANCEL</button>
          <button className="btn btn-dark" disabled={!auCreateName.trim()} onClick={createCharacterAu}>CREATE</button>
        </>}>
        <KInput autoFocus placeholder="예: 학원 AU, 판타지 AU" value={auCreateName}
          onChange={e => setAuCreateName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') createCharacterAu(); }} />
      </Modal>
      <ConfirmModal open={auDelAsk !== null} title="AU 프로필을 삭제하시겠습니까?"
        body={`「${charAus.find(a => a.key === auDelAsk)?.label ?? 'AU'}」의 프로필과 이미지 연결 정보가 삭제됩니다. ORIGINAL 캐릭터와 자관 AU는 삭제되지 않습니다.`}
        onClose={() => setAuDelAsk(null)}
        buttons={[
          { label: 'DELETE', kind: 'accent', onClick: () => { if (auDelAsk) deleteCharacterAu(auDelAsk); } },
          { label: 'CANCEL', kind: 'ghost', onClick: () => setAuDelAsk(null) },
        ]} />
      <div className="profile-editorial">
        <button type="button" className="profile-back" onClick={() => router.push('/chars')} aria-label="캐릭터 목록으로 돌아가기">
          ← BACK
        </button>

        {/* 좁은 좌측 레일 — AU와 INFO 탭은 기존 기능을 그대로 유지한다. */}
        <nav className="side-icons profile-editorial-rail" aria-label="캐릭터 프로필 탐색">
          <div className="side-icon-group">
            <span className="side-icon-label">AU</span>
            <button className={'side-au-button ' + (auKey === null ? 'on' : '')}
              data-tip="ORIGINAL" aria-label="ORIGINAL 프로필" onClick={() => setAuKey(null)}>
              <span className={'side-au-face ph ' + ch.thumbClass}>
                {charThumbRef(ch)
                  ? <CroppedBlobImg fileRef={charThumbRef(ch)} crop={ch.thumbCrop} ph={ch.thumbClass} />
                  : <b>O</b>}
              </span>
            </button>
            {charAus.map(a => {
              const av = charWithAu(ch, a.key);
              const faceRef = av.thumbId ?? (a.source === 'relation' ? (av.outfits?.[0]?.imgId ?? av.arts?.[0]) : undefined);
              const tip = a.source === 'relation' ? a.label + ' · ' + (a.relName ?? '자관') + ' AU' : a.label;
              return (
                <button key={a.key} className={'side-au-button ' + (auKey === a.key ? 'on' : '')}
                  data-tip={tip} aria-label={a.label + ' 프로필'} onClick={() => setAuKey(a.key)}>
                  <span className={'side-au-face ph ' + ch.thumbClass}>
                    {faceRef
                      ? <CroppedBlobImg fileRef={faceRef} crop={av.thumbCrop} ph={ch.thumbClass} />
                      : <b>{a.label.trim().charAt(0) || 'A'}</b>}
                  </span>
                </button>
              );
            })}
            {canEdit && (
              <button className="side-au-add" data-tip="새 AU 추가" aria-label="새 AU 추가"
                onClick={() => setAuCreateOpen(true)}>＋</button>
            )}
          </div>

          {auRegistered && (
            <>
              <div className="side-icon-divider" aria-hidden="true" />
              <div className="side-icon-group">
                <span className="side-icon-label">INFO</span>
                <button className={tab === 'basic' ? 'on' : ''} data-tip="기본 정보" aria-label="기본 정보"
                  onClick={() => pickTab('basic')}>☰</button>
                {visibleTabs.map(t => (
                  <button key={t.id} className={(tab === t.id ? 'on ' : '') + (t.visibility === 'private' ? 'side-tab-private' : '')}
                    data-tip={(t.title || '추가 프로필') + (t.visibility === 'private' ? ' · 비공개' : '')}
                    aria-label={(t.title || '추가 프로필') + (t.visibility === 'private' ? ' 비공개' : '')}
                    onClick={() => pickTab(t.id)}>{t.icon}{t.visibility === 'private' && <span aria-hidden="true">🔒</span>}</button>
                ))}
              </div>
            </>
          )}
        </nav>

        {auKey && !auRegistered ? (
          <div className="panel profile-au-empty">
            <div className="profile-au-empty-title">{charAus.find(a => a.key === auKey)?.label ?? 'AU'}</div>
            <p>이 AU의 「{ch.name}」이 아직 등록되지 않았습니다 — 등록하면 이 캐릭터의 AU 프로필로 연동됩니다</p>
            {canEdit && <button className="btn btn-dark" onClick={() => router.push(editHref)}>＋ AU 캐릭터 등록</button>}
          </div>
        ) : (
          <>
            {/* 왼쪽 큰 전신 화보 영역 — 페이지 높이를 채우고 정보가 길어도 화면에 남는다. */}
            <section className="profile-editorial-stage" aria-label={eff.name + ' 전신'}>
              <div className="profile-stage-kicker">
                <span>{auKey ? (charAus.find(a => a.key === auKey)?.label ?? 'AU') : 'ORIGINAL'}</span>
                {activeOutfit && <b>{activeOutfit.label}</b>}
              </div>
              <span className="profile-editorial-watermark" aria-hidden="true">{eff.name}</span>

              <div className={'profile-editorial-art-frame ' + (!activeOutfit ? 'ph ' + ch.thumbClass : '')}
                ref={artBoxRef}
                onContextMenu={e => {
                  if (!canEdit || !showingBaseFullArt || !baseFullArt) return;
                  e.preventDefault();
                  setArtCtx({ x: e.clientX, y: e.clientY, ref: baseFullArt });
                }}>
                {activeOutfit ? (
                  showingBaseFullArt && eff.artCrop ? (
                    <CroppedBlobImg fileRef={activeOutfit.imgId}
                      crop={eff.artCrop} ph={ch.thumbClass} label="CHARACTER FULL ART" />
                  ) : (
                    <FullArtBlobImg fileRef={activeOutfit.imgId}
                      ph={ch.thumbClass} label="CHARACTER FULL ART" alt={eff.name + ' · ' + activeOutfit.label + ' 전신'} />
                  )
                ) : <span>CHARACTER FULL ART</span>}
              </div>

              {outfitChoices.length > 0 && (
                <div className="profile-outfit-switch" aria-label="의상 전신 선택">
                  <span className="profile-outfit-label">OUTFIT</span>
                  <div>
                    {outfitChoices.map((o, i) => (
                      <button key={o.id} type="button" className={i === activeOutfitIdx ? 'on' : ''}
                        aria-pressed={i === activeOutfitIdx} onClick={() => setArtIdx(i)}>
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {/* 오른쪽은 카드 테두리를 없앤 편집 화보형 정보 영역. 동적 스펙/탭 데이터는 그대로 사용한다. */}
            <section className="profile-editorial-info" ref={infoRef} style={{ fontFamily: familyOf(eff.bodyFontId) }}>
              <div className="profile-info-head">
                <div className="profile-kicker">
                  {tab === 'basic'
                    ? (auKey ? (charAus.find(a => a.key === auKey)?.label ?? 'AU') : 'CHARACTER PROFILE')
                    : (curTab?.title?.trim() || 'PROFILE')}
                </div>
                <div className="profile-info-actions">
                  {canEdit && <button className="btn btn-dark" onClick={() => router.push(editHref)}>EDIT</button>}
                  {canEdit && auKey && isCharacterAuKey(auKey) && (
                    <button className="btn btn-ghost" onClick={() => setAuDelAsk(auKey)}>AU DELETE</button>
                  )}
                  {isAdmin && <button className="btn btn-ghost" onClick={() => setDelAsk(true)}>DELETE</button>}
                </div>
              </div>

              {workStatusMeta && (
                <span className={`char-work-badge profile-work-badge status-${eff.workStatus}`}>
                  <i aria-hidden="true">{workStatusMeta.icon}</i>{workStatusMeta.label}
                </span>
              )}

              <div className="profile-name" style={{
                fontFamily: familyOf(eff.fontId) ?? 'var(--serif)',
                '--character-name-size': (eff.nameSize ?? 38) + 'px',
                fontWeight: 500,
              } as React.CSSProperties}>{eff.name}</div>
              {eff.altName && <div className="profile-alt-name">{eff.altName}</div>}
              {eff.sub && <div className="sub profile-sub">{eff.sub}</div>}
              {eff.quote && <div className="profile-quote">“{eff.quote}”</div>}

              {eff.colors.length > 0 && (
                <div className="profile-palette" aria-label="테마 컬러">
                  {eff.colors.map(c => {
                    const tip = eff.colorTipMode === 'label' ? (c.label || c.hex.toUpperCase())
                      : eff.colorTipMode === 'both' ? (c.label ? c.label + ' · ' + c.hex.toUpperCase() : c.hex.toUpperCase())
                      : c.hex.toUpperCase();
                    return <span key={c.hex + c.label} className="sw-static" data-hex={tip}
                      title={tip} style={{ background: c.hex, boxShadow: chipBorder(eff.colorBd) }} />;
                  })}
                </div>
              )}

              {tab === 'basic' ? (
                <>
                  <dl className="spec profile-editorial-spec">
                    {eff.specs.filter(s => s.value.trim()).map(s => (
                      <div className="spec-item" key={s.label}><dt>{s.label}</dt><dd>{s.value}</dd></div>
                    ))}
                  </dl>
                  {basicHtml && (
                    <section className="profile-copy">
                      <div className="profile-section-label">INTRODUCTION</div>
                      <div className="prose" dangerouslySetInnerHTML={{ __html: basicHtml }} />
                    </section>
                  )}
                </>
              ) : (
                <section className="profile-tab-section">
                  {curTab?.subtitle && <div className="sub">{curTab.subtitle}</div>}
                  {tabHtml && <div className="prose profile-tab-copy" dangerouslySetInnerHTML={{ __html: tabHtml }} />}
                </section>
              )}
            </section>
          </>
        )}
      </div>

      {/* 대표 아트 우클릭 메뉴 (v2.0) — 상세 화면에 보일 위치 조정 */}
      {artCtx && createPortal(
        <div className="ctx-menu on" style={{ left: artCtx.x, top: artCtx.y }} onClick={e => e.stopPropagation()}>
          <div className="ctx-ttl">대표 아트</div>
          <button onClick={() => { setArtCropOpen({ ref: artCtx.ref, ratio: artBoxRatio() }); setArtCtx(null); }}>
            이미지 위치 조정
          </button>
          {(eff?.artCrop) && (
            <button onClick={() => { saveArtCrop(undefined); setArtCtx(null); }}>위치 지정 해제</button>
          )}
        </div>,
        document.body,
      )}
      {artCropOpen && (
        <ArtCropModal fileRef={artCropOpen.ref} ratio={artCropOpen.ratio} crop={eff?.artCrop}
          onClose={() => setArtCropOpen(null)}
          onApply={c => { saveArtCrop(c); setArtCropOpen(null); }} />
      )}
    </section>
  );
}

/** 상세 아트 위치 편집기 (v2.0) — 실제 표시 영역의 비율 그대로 열어야 보이는 대로 맞출 수 있다.
 *  이 영역은 화면 높이에 따라 달라지므로 고정 비율(3:4 등)을 쓰면 편집기와 결과가 어긋난다. */
function ArtCropModal({ fileRef, ratio, crop, onClose, onApply }: {
  fileRef: string; ratio: number; crop?: CropValue; onClose: () => void; onApply: (c: CropValue) => void;
}) {
  const url = useBlobUrl(fileRef);
  if (!url) return null;
  return (
    <CropEditor open src={url} aspect={ratio} aspectLabel="상세 화면과 같은 비율"
      initial={crop} onClose={onClose} onApply={onApply} />
  );
}

export default function CharDetailPage() {
  // useSearchParams는 Suspense 경계 필요 (Next App Router)
  return <Suspense fallback={<section className="page" />}><CharDetailInner /></Suspense>;
}
