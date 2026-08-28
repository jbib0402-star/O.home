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
  chipBorder, isCharacterAuKey, Relation, REL_SEED,
} from '@/lib/charStore';
import { sanitizeHtml } from '@/lib/sanitize';
import { useFonts } from '@/lib/fontStore';
import { useTheme } from '@/lib/ThemeProvider';
import { createPortal } from 'react-dom';
import { useBlobUrl } from '@/lib/blobStore';
import { CroppedBlobImg, CropEditor, type CropValue } from '@/components/ui/CropEditor';

import { EditableDesc, PageTitle } from '@/components/ui/PageText';
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
    sub: '',
    basicHtml: '',
    tabs: [],
    specs: [{ label: '성별', value: '' }, { label: '키', value: '' }],
    color: base.color,
    themeMode: 'default',
    colors: [],
    colorTipMode: 'hex',
    arts: [],
    thumbId: undefined,
    thumbCrop: undefined,
    artCrop: undefined,
    fontId: base.fontId ?? 'serif',
    nameSize: base.nameSize ?? 38,
    bodyFontId: base.bodyFontId ?? 'default',
  };
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
    router.push(`/chars/${ch.id}/edit?au=${encodeURIComponent(key)}`);
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

  const curTab = eff?.tabs.find(t => t.id === tab);
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

  return (
    <section className="page page-char-detail">
      <div className="page-head">
        {/* 제목 자리는 메뉴 이름 — 클릭 시 목록 복귀. 캐릭터 이름은 우측 프로필 패널에 크게 표시 */}
        <PageTitle>CHARACTERS</PageTitle>
        {/* 캐릭터별로 별도 저장 — 키에 캐릭터 id 포함 */}
        <EditableDesc k={`char-detail-desc:${ch.id}`} def="좌측 아이콘 탭 → 우측 정보 전환" />
        <div className="head-actions">
          {/* 관리자 또는 「편집까지」 권한 회원 (3차 회원-캐릭터 연결, v1.9)
              — AU 선택 상태의 EDIT은 그 AU 전용 프로필 편집으로 진입 */}
          {canEdit && (
            <button className="btn btn-dark" onClick={() => router.push(editHref)}>EDIT</button>
          )}
          {isAdmin && <button className="btn btn-dark" onClick={() => setDelAsk(true)}>DELETE</button>}
        </div>

        <ConfirmModal open={delAsk} title="캐릭터를 삭제하시겠습니까?"
          body="프로필·탭 정보가 함께 삭제되며 복구할 수 없습니다. 이 캐릭터가 들어간 자관에서는 멤버 표시가 사라집니다."
          onClose={() => setDelAsk(false)}
          buttons={[
            { label: 'DELETE', kind: 'accent', onClick: () => { setChars(chars.filter(c => c.id !== ch.id)); router.push('/chars'); } },
            { label: 'CANCEL', kind: 'ghost', onClick: () => setDelAsk(false) },
          ]} />
      </div>
      {/* 캐릭터 자체 AU + 자관 AU. 새 자체 AU는 charau: namespace로 별도 저장한다. */}
      <div className="char-au-panel">
        <div className="char-au-title">AU PROFILE</div>
        <div className="char-au-list">
          <button className={`char-au-chip ${auKey === null ? 'on' : ''}`}
            onClick={() => setAuKey(null)}>
            <span className={`char-au-face ph ${ch.thumbClass}`}>
              {charThumbRef(ch) && <CroppedBlobImg fileRef={charThumbRef(ch)} crop={ch.thumbCrop} ph={ch.thumbClass} />}
            </span>
            <b>ORIGINAL</b>
          </button>
          {charAus.map(a => {
            const av = charWithAu(ch, a.key);
            // 기존 자관 AU는 종전과 같이 그 AU의 첫 아트를 썸네일 fallback으로 허용한다.
            // 새 캐릭터 자체 AU는 두상/전신 독립 규칙에 따라 thumbId만 쓴다.
            const faceRef = av.thumbId ?? (a.source === 'relation' ? av.arts?.[0] : undefined);
            return (
              <button key={a.key} className={`char-au-chip ${auKey === a.key ? 'on' : ''}`}
                data-tip={a.source === 'relation' ? `${a.relName} · 자관 AU` : '캐릭터 자체 AU'}
                onClick={() => setAuKey(a.key)}>
                <span className={`char-au-face ph ${ch.thumbClass}`}>
                  {faceRef && <CroppedBlobImg fileRef={faceRef} crop={av.thumbCrop} ph={ch.thumbClass} />}
                </span>
                <b>{a.label}</b>
              </button>
            );
          })}
          {canEdit && (
            <button className="char-au-chip add" onClick={() => setAuCreateOpen(true)}>
              <span className="char-au-plus">＋</span><b>AU</b>
            </button>
          )}
        </div>
        {canEdit && auKey && isCharacterAuKey(auKey) && (
          <button className="btn btn-ghost char-au-delete" onClick={() => setAuDelAsk(auKey)}>AU 삭제</button>
        )}
      </div>
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
      {/* AU 미등록 (v1.9 사용자 확정) — base를 보여주지 않고 그 AU에 맞춰 캐릭터를 새로 등록 */}
      {auKey && !auRegistered ? (
        <div className="panel" style={{ textAlign: 'center', padding: 56 }}>
          <div style={{ fontFamily: 'var(--serif)', fontSize: 24, letterSpacing: '.14em', marginBottom: 8 }}>
            {charAus.find(a => a.key === auKey)?.label ?? 'AU'}
          </div>
          <p style={{ fontSize: 13, color: 'var(--faint)', marginBottom: 16 }}>
            이 AU의 「{ch.name}」이 아직 등록되지 않았습니다 — 등록하면 이 캐릭터의 AU 프로필로 연동됩니다
          </p>
          {(isAdmin || charGrant(ch, user?.id) === 'edit') && (
            <button className="btn btn-dark" onClick={() => router.push(editHref)}>＋ AU 캐릭터 등록</button>
          )}
        </div>
      ) : (
      <div className="profile-wrap">
        {/* 좌측 아이콘 탭 — AU면 그 AU의 탭 구성 */}
        <div className="side-icons">
          <button className={tab === 'basic' ? 'on' : ''} data-tip="기본 정보" onClick={() => pickTab('basic')}>☰</button>
          {eff.tabs.map(t => (
            <button key={t.id} className={tab === t.id ? 'on' : ''} data-tip={t.title} onClick={() => pickTab(t.id)}>{t.icon}</button>
          ))}
          {isAdmin && (
            <button data-tip="탭 추가 (편집모드)" style={{ borderStyle: 'dashed', fontSize: 13 }}
              onClick={() => router.push(editHref)}>＋</button>
          )}
        </div>

        {/* 중앙 아트 — 스티키 · 추가 아트가 있으면 클릭으로 넘겨보기 */}
        {(() => {
          const arts = eff.arts && eff.arts.length > 0 ? eff.arts : (eff.artId ? [eff.artId] : []);
          if (arts.length === 0 && !eff.artUrl) {
            return <div className={`profile-center ph ${ch.thumbClass}`}><span>CHARACTER FULL ART</span></div>;
          }
          const cur = Math.min(artIdx, arts.length - 1);
          return (
            <div className="profile-center" ref={artBoxRef}
              style={{ cursor: arts.length > 1 ? 'pointer' : undefined }}
              onClick={() => { if (arts.length > 1) setArtIdx(i => (i + 1) % arts.length); }}
              /* 대표 아트 우클릭 → 이 화면에 보일 위치 조정 (관리자, v2.0 사용자 확정) */
              onContextMenu={e => {
                if (!(isAdmin || charGrant(ch, user?.id) === 'edit') || cur !== 0) return;
                e.preventDefault();
                setArtCtx({ x: e.clientX, y: e.clientY, ref: arts[0] });
              }}>
              {/* 지정한 크롭 위치를 여기서도 쓴다 — 예전에는 가운데 기준으로 잘려서
                  리스트에서 맞춰 둔 위치와 다른 곳이 보였다 (대표 아트에만 적용) */}
              {/* 리스트 썸네일 크롭은 3:4 기준이라 여기(화면 높이에 따라 비율이 달라지는 영역)에는
                  맞지 않는다 — 여기서 따로 잡은 값이 있을 때만 쓰고, 없으면 가운데 기준 (v2.0) */}
              <CroppedBlobImg fileRef={arts[cur] ?? eff.artUrl}
                crop={cur === 0 ? eff.artCrop : undefined}
                ph={ch.thumbClass} label="CHARACTER FULL ART" />
              {arts.length > 1 && (
                <div style={{ position: 'absolute', left: 0, right: 0, bottom: 12, display: 'flex', justifyContent: 'center', gap: 5, zIndex: 3 }}>
                  {arts.map((_, i) => (
                    <i key={i} style={{
                      width: i === cur ? 16 : 6, height: 6, borderRadius: 4,
                      background: i === cur ? '#fff' : 'rgba(255,255,255,.45)', transition: '.2s',
                    }} />
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* 우측 정보 패널 — 최상단 캐릭터 이름 크게 (v1.6) · AU면 그 AU의 이름·폰트 */}
        <div className="panel profile-info" ref={infoRef} style={{ fontFamily: familyOf(eff.bodyFontId) }}>
          {/* 크기는 캐릭터마다 직접 정한다 (등록·수정의 「이름 크기」) — 자동으로 줄이면
              이름 길이에 따라 어중간해져서, 정한 크기를 그대로 쓴다 (v2.0 사용자 확정) */}
          <div style={{
            fontFamily: familyOf(eff.fontId) ?? 'var(--serif)', fontSize: eff.nameSize ?? 38,
            fontWeight: 600, letterSpacing: '.2em', lineHeight: 1.1,
          }}>{eff.name}</div>
          <div className="sub" style={{ marginBottom: 14 }}>{eff.sub}</div>

          {tab === 'basic' ? (
            <>
              {/* 기본 정보 탭은 제목을 두지 않는다 — 처음 보이는 화면이라 안내가 필요 없다
                  (다른 탭은 무엇을 보는 중인지 알아야 하므로 제목을 그대로 둔다) */}
              <dl className="spec">
                {eff.specs.map(s => (
                  <React.Fragment key={s.label}><dt>{s.label}</dt><dd>{s.value}</dd></React.Fragment>
                ))}
                {eff.colors.length > 0 && (
                  <>
                    <dt>테마컬러</dt>
                    <dd>
                      <span style={{ display: 'inline-flex', gap: 7, alignItems: 'center' }}>
                        {/* 색 점 나열 — hex는 호버 툴팁만 (v1.8) */}
                        {eff.colors.map(c => {
                          // 툴팁 표기: hex / 이름+hex / 이름만 (등록 시 선택)
                          const tip = eff.colorTipMode === 'label' ? (c.label || c.hex.toUpperCase())
                            : eff.colorTipMode === 'both' ? (c.label ? `${c.label} · ${c.hex.toUpperCase()}` : c.hex.toUpperCase())
                            : c.hex.toUpperCase();
                          return (
                            <span key={c.hex + c.label} className="sw-static" data-hex={tip}
                              style={{ background: c.hex, boxShadow: chipBorder(eff.colorBd) }} />
                          );
                        })}
                      </span>
                    </dd>
                  </>
                )}
              </dl>
              <div className="prose" dangerouslySetInnerHTML={{ __html: basicHtml }} />
            </>
          ) : (
            <>
              <h3>{curTab?.title}</h3>
              {curTab?.subtitle && <div className="sub">{curTab.subtitle}</div>}
              <div className="prose" dangerouslySetInnerHTML={{ __html: tabHtml }} />
            </>
          )}
        </div>
      </div>
      )}

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
