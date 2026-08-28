'use client';
// 캐릭터 프로필 편집 페이지 (4.4) — 전용 페이지 (모달 아님)
// ?au=<relId:auId|charau:id> 로 진입하면 그 AU 전용 프로필 편집 —
// 아예 새 프로필처럼 이름·스펙·아트·탭 전부 그 AU만의 값으로 작성. base는 건드리지 않음.
import React, { Suspense } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { useLocalList } from '@/lib/postStore';
import {
  Character, CHAR_SEED, charGrant, charWithAu, isCharacterAuKey, Relation, REL_SEED,
} from '@/lib/charStore';
import { CharEditForm } from '@/components/chars/CharEditForm';
import { useToast } from '@/components/ui/Toast';
import { PageTitle, EditableDesc } from '@/components/ui/PageText';

function CharEditInner() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { user, isAdmin } = useAuth();
  const toast = useToast();
  const params = useSearchParams();
  const auKey = params.get('au');   // 자관 `${relId}:${auId}` 또는 캐릭터 자체 `charau:${id}`
  // 자체 AU를 만든 직후 서버 동기화보다 이 페이지가 먼저 열릴 수 있어 생성 당시 이름도 받는다.
  // 자관 AU에는 적용하지 않아 기존 자관 이름 결정 방식을 그대로 유지한다.
  const pendingCharAuLabel = auKey && isCharacterAuKey(auKey)
    ? (params.get('aulabel')?.trim() || undefined)
    : undefined;
  const [chars, setChars, loaded] = useLocalList<Character>('ohome.chars.v1', CHAR_SEED);
  const [rels] = useLocalList<Relation>('ohome.rels.v1', REL_SEED);

  const ch = chars.find(c => c.id === id);
  // 관리자 또는 「편집까지」 권한이 부여된 회원 (3차 회원-캐릭터 연결, v1.9)
  const canEdit = isAdmin || (ch && charGrant(ch, user?.id) === 'edit');
  if (!loaded) return <section className="page" />;
  if (!canEdit || !ch) {
    return (
      <section className="page">
        <div className="page-head"><PageTitle>EDIT</PageTitle><p>{!ch ? '캐릭터를 찾을 수 없습니다' : '편집 권한이 없습니다'}</p></div>
      </section>
    );
  }

  const charAu = auKey && isCharacterAuKey(auKey) ? ch.auProfiles?.[auKey] : undefined;
  // AU 라벨 (타이틀 표시용) — 캐릭터 자체 AU는 프로필 안 label, 자관 AU는 Relation.aus
  const auLabel = (() => {
    if (!auKey) return null;
    if (isCharacterAuKey(auKey)) return charAu?.label ?? pendingCharAuLabel ?? 'AU';
    const [relId, auId] = auKey.split(':');
    return rels.find(r => r.id === relId)?.aus.find(a => a.id === auId)?.label ?? auKey;
  })();

  const back = auKey ? `/chars/${ch.id}?au=${encodeURIComponent(auKey)}` : `/chars/${ch.id}`;

  // AU 프로필 초기값 (v1.9 사용자 확정) — 이미 등록된 AU면 그 값, 처음이면 "아예 새 등록"처럼 빈 폼
  // (이름·스펙·아트·탭 전부 비움 — 폰트·대표색 등 스타일 기본만 base에서)
  const auProf = auKey ? ch.auProfiles?.[auKey] : undefined;
  const formInitial = auKey
    ? (auProf
      ? charWithAu(ch, auKey)
      : {
        ...ch, name: '', sub: '', basicHtml: '', tabs: [], colors: [], colorTipMode: 'hex' as const,
        specs: [{ label: '성별', value: '' }, { label: '키', value: '' }],
        arts: [], artId: undefined, artUrl: undefined,
        thumbId: undefined, thumbCrop: undefined, artCrop: undefined,
      })
    : ch;

  return (
    <section className="page">
      <div className="page-head">
        <PageTitle>EDIT — {auKey ? `${ch.name} · ${auLabel}` : ch.name}</PageTitle>
        {!auKey && <EditableDesc k="chars-edit-desc" def="프로필 편집 — 변경은 [SAVE]를 눌러야 저장됩니다" />}
      </div>
      <CharEditForm
        initial={formInitial}
        auMode={!!auKey}
        auLabel={auLabel ?? undefined}
        auLabelEditable={!!auKey && isCharacterAuKey(auKey)}
        onCancel={() => router.push(back)}
        onSave={(c, savedAuLabel) => {
          if (auKey) {
            // AU 프로필 스냅샷 저장 — base 필드는 그대로, auProfiles[auKey]만 폼 값 전체로
            setChars(chars.map(x => (x.id === ch.id ? {
              ...x,
              auProfiles: {
                ...x.auProfiles,
                [auKey]: {
                  // 폼 밖에서 정한 값(상세 아트 위치 등)은 그대로 두고 폼 값만 덮어쓴다 (v2.0)
                  ...x.auProfiles?.[auKey],
                  ...(isCharacterAuKey(auKey) ? {
                    label: savedAuLabel ?? auLabel ?? 'AU', source: 'character' as const,
                  } : {}),
                  name: c.name, sub: c.sub, color: c.color, themeMode: c.themeMode,
                  colors: c.colors, colorBd: c.colorBd, colorTipMode: c.colorTipMode,
                  specs: c.specs, tabs: c.tabs, basicHtml: c.basicHtml,
                  arts: c.arts, thumbId: c.thumbId, thumbCrop: c.thumbCrop,
                  fontId: c.fontId, nameSize: c.nameSize, bodyFontId: c.bodyFontId,
                },
              },
            } : x)));
            toast('AU 프로필이 저장되었습니다');
          } else {
            // 폼이 다루지 않는 값(상세 아트 위치 등)이 저장할 때마다 사라지지 않게 덮어쓰지 않고 합친다 (v2.0)
            setChars(chars.map(x => (x.id === c.id ? { ...x, ...c } : x)));
            toast('저장되었습니다');
          }
          router.push(back);
        }}
      />
    </section>
  );
}

export default function CharEditPage() {
  // useSearchParams는 Suspense 경계 필요 (Next App Router)
  return <Suspense fallback={<section className="page" />}><CharEditInner /></Suspense>;
}
