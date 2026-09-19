'use client';
// 그림게시판 로드뷰 (4.10) — 목록 없이 최신순 즉시 표시 · 좌 그림/우 댓글 · 즉시 업로드 · 접기
import React, { Suspense, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { useMembers } from '@/lib/members';
import { useSectionParam, filterSection, sectionSetter } from '@/lib/sectionStore';
import {
  useLocalList, newId, fmtDate, Comment,
  CommentRow, COMMENT_KEY, COMMENT_SEED, commentsFor,
} from '@/lib/postStore';
import { RoadItem, ROAD_SEED } from '@/lib/galleryStore';
import { SearchBar, KInput } from '@/components/ui/Kit';
import { putBlob, useBlobUrl } from '@/lib/blobStore';
import { Modal, ConfirmModal, useConfirmDelete } from '@/components/ui/Modal';
import { EditableDesc, PageTitle } from '@/components/ui/PageText';
import { KCheck } from '@/components/ui/Kit';
import { useToast } from '@/components/ui/Toast';
import { pushNotif } from '@/lib/notifStore';
import { useMenuSettings, MenuPerm } from '@/lib/menuStore';
import { fileDrop } from '@/lib/dnd';
import { youtubeVideoId } from '@/lib/youtube';

const PAGE_SIZE = 4;
const FOLD_LABEL = { spoiler: '스포일러', adult: '수위 주의' };

function RoadBlock({ item, comments, onComment, onEditComment, onDeleteComment, canComment, viewerId, isAdmin, adminIds, editLevel, delLevel, canEditItem, canDeleteItem, onEdit, onDelete }: {
  item: RoadItem;
  comments: Comment[];                                  // 이 그림의 댓글 — 분리 저장분 + 옛 항목 안의 것 (v2.0)
  onComment: (id: string, text: string, options: { secret: boolean; folded: boolean; parentId?: string }) => void;
  onEditComment: (id: string, cid: string, text: string) => void;
  onDeleteComment: (id: string, cid: string) => void;
  canComment: boolean;                                  // 로드비 댓글은 로그인한 회원만 작성 가능
  viewerId?: string;
  isAdmin: boolean;
  adminIds: Set<string>;                                // 작성자의 역할 기준 — 보는 사람과 무관하게 관리자 댓글 좌측 고정
  editLevel: (c: Comment) => 'free' | 'pw' | null;      // 수정 — 본인만 (게스트는 비밀번호)
  delLevel: (c: Comment) => 'free' | 'pw' | null;       // 삭제 — 본인·관리자 (게스트는 비밀번호)
  canEditItem: boolean;                                 // 그림 수정 — 작성자 본인만 (v1.9)
  canDeleteItem: boolean;                               // 그림 삭제 — 작성자·관리자
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [mediaCollapsed, setMediaCollapsed] = useState(!!item.mediaFolded);
  const [text, setText] = useState('');
  const [secret, setSecret] = useState(false);
  const [foldComment, setFoldComment] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyLabel, setReplyLabel] = useState('');
  const [replyText, setReplyText] = useState('');
  const [replySecret, setReplySecret] = useState(false);
  const [replyFolded, setReplyFolded] = useState(false);
  // 댓글 인라인 수정 (v1.9)
  const [editCid, setEditCid] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  // 게스트 댓글 관리 — 비밀번호 확인 모달
  const del = useConfirmDelete();
  useEffect(() => {
    setMediaCollapsed(!!item.mediaFolded);
  }, [item.id, item.mediaFolded]);

  const folded = item.fold && !open;
  const secretLocked = !!item.secret && !isAdmin && item.authorId !== viewerId;
  // "접어서 올리기"로 저장된 미디어만 그라데이션 미리보기를 사용한다.
  // 수위 주의 커버와 비밀글 잠금이 먼저 보여야 하므로 두 상태에서는 중첩하지 않는다.
  const mediaPreviewCollapsed = mediaCollapsed && !folded && !secretLocked;
  const imgSrc = useBlobUrl(secretLocked ? undefined : (item.imgId ?? item.imgUrl));
  const youtubeSrc = item.youtubeId
    ? `https://www.youtube-nocookie.com/embed/${item.youtubeId}?rel=0`
    : undefined;
  const saveEdit = () => {
    if (editCid && editText.trim()) onEditComment(item.id, editCid, editText.trim());
    setEditCid(null);
  };
  const post = () => {
    if (!canComment || !text.trim()) return;
    onComment(item.id, text.trim(), { secret, folded: foldComment });
    setText('');
    setSecret(false);
    setFoldComment(false);
  };
  const askManage = (c: Comment, mode: 'edit' | 'del') => {
    const level = mode === 'edit' ? editLevel(c) : delLevel(c);
    if (level !== 'free') return;
    if (mode === 'edit') { setEditCid(c.id); setEditText(c.text); }
    else del.ask('이 댓글을 삭제하시겠습니까?', () => onDeleteComment(item.id, c.id));
  };
  const openReply = (c: Comment, threadId: string) => {
    setReplyTo(threadId);
    setReplyLabel(c.author);
    setReplyText('');
    setReplySecret(!!c.secret);
    setReplyFolded(false);
  };
  const postReply = () => {
    if (!canComment || !replyTo || !replyText.trim()) return;
    onComment(item.id, replyText.trim(), { secret: replySecret, folded: replyFolded, parentId: replyTo });
    setReplyTo(null);
    setReplyLabel('');
    setReplyText('');
    setReplySecret(false);
    setReplyFolded(false);
  };
  const renderComment = (c: Comment, replyDepth = false, threadId = c.id) => {
    const parent = c.parentId ? comments.find(x => x.id === c.parentId) : undefined;
    const canRead = !c.secret || isAdmin || (!!viewerId
      && (c.authorId === viewerId || item.authorId === viewerId || parent?.authorId === viewerId));
    const isFolded = !!c.folded && !expanded.has(c.id);
    const adminComment = !!c.authorId && adminIds.has(c.authorId);
    return (
      <div className={`cmt loadb-chat ${replyDepth ? 'reply-depth' : ''} ${c.secret ? 'secret' : ''} ${adminComment ? 'admin' : 'other'}`} key={c.id}>
        <div className="loadb-chat-meta">
          <b>{c.author}</b>
          {c.secret && <small className="cmt-secret-mark">🔒 비밀</small>}
        </div>

        <div className="loadb-chat-bubble">
          {!canRead ? (
            <p className="cmt-hidden">🔒 비밀 댓글입니다.</p>
          ) : editCid === c.id ? (
            <div className="loadb-chat-edit">
              <KInput value={editText} autoFocus onChange={e => setEditText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') saveEdit(); if (e.key === 'Escape') setEditCid(null); }}
                style={{ flex: 1 }} />
              <button className="btn btn-dark" onClick={saveEdit}>SAVE</button>
              <button className="btn btn-ghost" onClick={() => setEditCid(null)}>✕</button>
            </div>
          ) : isFolded ? (
            <button className="cmt-fold-button" onClick={() => setExpanded(prev => new Set(prev).add(c.id))}>
              ▸ 접힌 댓글입니다 — 펼치기
            </button>
          ) : (
            <p>{c.text}</p>
          )}
        </div>

        <div className="loadb-chat-foot">
          <small className="loadb-chat-date">{fmtDate(c.date)}</small>
          {canRead && editCid !== c.id && (
            <span className="loadb-chat-tools">
              {canComment && (
                <button className="cmt-reply-action" onClick={() => openReply(c, threadId)}>답글</button>
              )}
              {editLevel(c) !== null && (
                <button onClick={() => askManage(c, 'edit')}>수정</button>
              )}
              {delLevel(c) !== null && (
                <button onClick={() => askManage(c, 'del')}>삭제</button>
              )}
            </span>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className={`panel roadview-item ${mediaPreviewCollapsed ? 'is-media-collapsed' : ''}`}>
      {/* 그림별 상단 번호 영역 */}
      <div className="rv-head">
        <b>No.{String(item.no ?? 0).padStart(3, '0')}</b>
        {(item.secret || item.visibility === 'private') && <span className="rv-secret-badge">🔒 SECRET</span>}
      </div>
      {/* 투명 PNG도 카드색 위에 자연스럽게 — 어두운 하드코딩 제거 (v1.9 사용자 피드백) */}
      <div id={`road-media-${item.id}`} className={`art ${folded ? 'veil' : ''}`} style={{ background: 'var(--panel-solid)' }}>
        {secretLocked ? (
          <div className="rv-secret-cover" role="status">
            <b>🔒 비밀글입니다</b>
            <span>작성자와 관리자만 볼 수 있습니다.</span>
          </div>
        ) : youtubeSrc && !folded ? (
          <iframe className="rv-youtube" src={youtubeSrc} title={`${item.title || `No.${item.no ?? 0}`} 유튜브 영상`}
            loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />
        ) : youtubeSrc ? (
          <div className="rv-youtube rv-youtube-folded" aria-hidden="true" />
        ) : imgSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={imgSrc} alt={item.title}
            className={`artimg ${item.narrow ? 'narrow' : ''}`} style={{ filter: folded ? 'blur(18px)' : undefined }} />
        ) : (
          <div className={`artimg ${item.narrow ? 'narrow' : ''} ph ${item.ph}`}
            style={{ aspectRatio: item.ratio, filter: folded ? 'blur(18px)' : undefined }}>
            <span>{item.title}</span>
          </div>
        )}
        {folded && !secretLocked && (
          <div className="cover" onClick={() => setOpen(true)}>
            <div>
              <b>{item.fold!.type === 'custom' ? (item.fold!.label || '접힘') : FOLD_LABEL[item.fold!.type]}</b><br />
              <span>클릭하여 표시</span>
            </div>
          </div>
        )}
        {mediaPreviewCollapsed && (
          <div className="rv-media-fade">
            <button type="button" className="rv-media-open"
              aria-expanded="false"
              aria-controls={`road-media-${item.id}`}
              onClick={() => setMediaCollapsed(false)}>
              <b>OPEN</b>
              <span>전체 이미지 보기</span>
            </button>
          </div>
        )}
        {!!item.mediaFolded && !mediaCollapsed && !folded && !secretLocked && (
          <button type="button" className="rv-media-close"
            aria-expanded="true"
            aria-controls={`road-media-${item.id}`}
            onClick={() => setMediaCollapsed(true)}>
            <b>CLOSE</b>
            <span>이미지 접기</span>
          </button>
        )}
        {(canEditItem || canDeleteItem) && (
          /* 이미지에 마우스를 올렸을 때만 표시 (.rv-actions — globals.css) · 수정은 작성자만, 삭제는 관리자도 */
          <div className="rv-actions" style={{ position: 'absolute', top: 12, right: 12, zIndex: 6, display: 'flex', gap: 6 }}>
            {canEditItem && (
              <button style={{ fontSize: 10.5, padding: '5px 11px', borderRadius: 999, background: 'rgba(15,17,20,.55)', color: '#dfe2e7' }}
                onClick={e => { e.stopPropagation(); onEdit(); }}>EDIT</button>
            )}
            {canDeleteItem && (
              <button style={{ fontSize: 10.5, padding: '5px 11px', borderRadius: 999, background: 'rgba(166,58,69,.75)', color: '#fff' }}
                onClick={e => { e.stopPropagation(); onDelete(); }}>DELETE</button>
            )}
          </div>
        )}
      </div>
      {secretLocked ? (
        <div className="cmt-side rv-secret-comments">
          <span>🔒 댓글도 비공개 상태입니다.</span>
        </div>
      ) : <div className="cmt-side">
        <div className="list">
          {comments.filter(c => !c.parentId || !comments.some(p => p.id === c.parentId)).map(c => (
            <React.Fragment key={c.id}>
              {renderComment(c)}
              {replyTo === c.id && (
                <div className="cmt-reply-form">
                  <div className="loadb-compose loadb-compose-reply">
                    <div className="loadb-compose-head">
                      <span>REPLY · {replyLabel}</span>
                      <div className="loadb-compose-actions">
                        <button type="button" className="loadb-compose-close" aria-label="답글 취소"
                          onClick={() => setReplyTo(null)}>×</button>
                        <button type="button" className="loadb-compose-submit" aria-label="답글 등록"
                          disabled={!replyText.trim()} onClick={postReply}>↑</button>
                      </div>
                    </div>
                    <textarea autoFocus value={replyText} placeholder="답글을 남겨주세요."
                      onChange={e => setReplyText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Escape') setReplyTo(null);
                        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); postReply(); }
                      }} />
                    <div className="loadb-compose-foot">
                      <div className="cmt-options">
                        <KCheck label="비밀 답글" checked={replySecret} onChange={setReplySecret} />
                        <KCheck label="답글 접기" checked={replyFolded} onChange={setReplyFolded} />
                      </div>
                      <small>Ctrl/Cmd + Enter 등록</small>
                    </div>
                  </div>
                </div>
              )}
              {comments.filter(r => r.parentId === c.id).map(r => renderComment(r, true, c.id))}
            </React.Fragment>
          ))}
          {comments.length === 0 && <p className="hint">첫 댓글을 남겨보세요</p>}
        </div>
        {/* 참고 이미지형 메모 입력 — 비로그인은 열람만, 로그인한 회원만 댓글 작성 */}
        <div className="cmt-input">
          <div className="loadb-compose">
            <div className="loadb-compose-head">
              <span>MEMO</span>
              <button type="button" className="loadb-compose-submit" aria-label="댓글 등록"
                disabled={!canComment || !text.trim()} onClick={post}>↑</button>
            </div>
            <textarea placeholder={canComment ? '댓글을 남겨주세요.' : '댓글은 로그인 후 작성할 수 있습니다.'}
              value={text} disabled={!canComment}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post(); }
              }} />
            <div className="loadb-compose-foot">
              {canComment ? (
                <div className="cmt-options">
                  <KCheck label="비밀 댓글" checked={secret} onChange={setSecret} />
                  <KCheck label="댓글 접기" checked={foldComment} onChange={setFoldComment} />
                </div>
              ) : <span />}
              <small>Ctrl/Cmd + Enter 등록</small>
            </div>
          </div>
        </div>
      </div>}
      {del.element}
    </div>
  );
}

function RoadviewPageInner() {
  const { user, isAdmin } = useAuth();
  const members = useMembers();
  const adminIds = new Set([
    ...members.filter(m => m.role === 'admin').map(m => m.id),
    ...(isAdmin && user ? [user.id] : []),
  ]);
  const toast = useToast();
  // 업로드·댓글 권한 3단계 (4.10 v1.7 — 환경설정 > 메뉴 관리의 로드뷰 항목).
  // 로드비 댓글은 설정값이 guest여도 실제 작성자는 로그인 회원으로 제한한다.
  const [menuSet] = useMenuSettings();
  const allow = (p: MenuPerm) => (p === 'admin' ? isAdmin : p === 'member' ? !!user : true);
  const [itemsAll, setItemsAll, roadLoaded] = useLocalList<RoadItem>('ohome.road.v1', ROAD_SEED);
  // 여러 개로 만든 섹션 (v2.0) — 주소의 ?s= 가 가리키는 것만 보여 준다
  const sec = useSectionParam('roadview');
  const sectionItems = filterSection(itemsAll, sec.id);
  // 새 비밀글은 목록 껍데기를 공개하고 미디어만 화면에서 잠근다. 예전 private 항목은 서버가
  // 비로그인에게 내려주지 않으므로, 작성자·관리자 화면에서만 하위 호환으로 유지한다.
  const items = sectionItems.filter(it => it.visibility !== 'private' || isAdmin || it.authorId === user?.id);
  // 저장은 이 섹션 자리만 교체 — 걸러진 목록을 그대로 넘겨도 다른 섹션이 지워지지 않는다
  const setItems = sectionSetter(itemsAll, sec.id, setItemsAll);
  // 댓글은 항목과 따로 저장한다 (v2.0) — 항목 안에 두면 댓글을 달 때 항목을 UPDATE 해야 해서
  // 일반 회원이 남의 그림에 댓글을 달 수 없었다 (게시판과 같은 원인)
  const [cmtRows, setCmtRows] = useLocalList<CommentRow>(COMMENT_KEY, COMMENT_SEED);
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE_SIZE);

  // 그림 번호 (v1.9) — 번호 없는 기존 그림은 오래된 순으로 자동 부여
  useEffect(() => {
    if (!roadLoaded) return;
    // 구형 비밀 업로드는 DB 행 자체가 private라 방문자 목록에도 없었다. 관리자가 로드비를
    // 처음 연 시점에만 새 방식(공개 목록 껍데기 + 잠긴 미디어)으로 한 번 변환한다.
    if (isAdmin && itemsAll.some(it => it.visibility === 'private')) {
      setItemsAll(itemsAll.map(it => it.visibility === 'private'
        ? { ...it, visibility: 'public', secret: true } : it));
      return;
    }
    if (items.some(it => it.no === undefined)) {
      let n = Math.max(0, ...items.map(it => it.no ?? 0));
      const next = [...items].sort((a, b) => a.date.localeCompare(b.date))
        .map(it => (it.no === undefined ? { ...it, no: ++n } : it));
      setItems(items.map(it => next.find(x => x.id === it.id) ?? it));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roadLoaded, isAdmin, itemsAll, setItemsAll]);
  // 다음 번호 — 항상 최대+1 자동 증가. 건너뛰기·재배치는 각 그림 편집 모달의 번호 수정으로 (v1.9)
  const nextNo = Math.max(0, ...items.map(it => it.no ?? 0)) + 1;
  const padNo = (n?: number) => `No.${String(n ?? 0).padStart(3, '0')}`;
  /** 삭제 후 현재 로드비 섹션의 번호만 기존 순서대로 1부터 다시 이어 붙인다. */
  const compactNumbers = (remaining: RoadItem[]) => {
    const ordered = [...remaining].sort((a, b) => {
      const an = a.no ?? Number.MAX_SAFE_INTEGER;
      const bn = b.no ?? Number.MAX_SAFE_INTEGER;
      return an === bn ? a.date.localeCompare(b.date) : an - bn;
    });
    const numbers = new Map(ordered.map((it, index) => [it.id, index + 1]));
    return remaining.map(it => ({ ...it, no: numbers.get(it.id) }));
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const [editFor, setEditFor] = useState<RoadItem | null>(null);
  const [eNo, setENo] = useState('');      // 번호 수정 (v1.9 — 제목 없이 번호만 쓰는 체계)
  const [eAdult, setEAdult] = useState(false);
  const [eSecret, setESecret] = useState(false);
  const [eMediaFolded, setEMediaFolded] = useState(false);
  const [delFor, setDelFor] = useState<RoadItem | null>(null);
  const [pendingUpload, setPendingUpload] = useState<File | null>(null);
  const [uploadSecret, setUploadSecret] = useState(false);
  const [uploadFolded, setUploadFolded] = useState(false);
  const [youtubeOpen, setYoutubeOpen] = useState(false);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [youtubeSecret, setYoutubeSecret] = useState(false);
  const [youtubeFolded, setYoutubeFolded] = useState(false);

  // 즉시 업로드 (v1.7) — IndexedDB 실저장 (R2 연동 시 서버로 이전)
  const upload = async (f: File | undefined, secretUpload = false, foldedUpload = false) => {
    if (!f) return;
    const imgId = await putBlob(f); // IndexedDB 실저장 — 새로고침에도 유지
    const it: RoadItem = {
      id: newId(), title: '', author: user!.nickname, authorId: user!.id,
      date: new Date().toISOString(), imgId, ph: '', ratio: 'auto',
      fold: null, comments: [],
      no: nextNo,   // 번호 자동 부여 (v1.9)
      visibility: 'public', secret: secretUpload, mediaFolded: foldedUpload,
    };
    setItems([it, ...items]);
    setPendingUpload(null);
    setUploadSecret(false);
    setUploadFolded(false);
    toast(`${padNo(it.no)} 업로드되었습니다`);
  };

  const uploadYoutube = () => {
    const youtubeId = youtubeVideoId(youtubeUrl);
    if (!youtubeId) { toast('올바른 유튜브 링크를 입력해 주세요'); return; }
    const it: RoadItem = {
      id: newId(), title: '', author: user!.nickname, authorId: user!.id,
      date: new Date().toISOString(), youtubeId, ph: '', ratio: '16 / 9',
      fold: null, comments: [], no: nextNo,
      visibility: 'public', secret: youtubeSecret, mediaFolded: youtubeFolded,
    };
    setItems([it, ...items]);
    setYoutubeUrl('');
    setYoutubeOpen(false);
    setYoutubeSecret(false);
    setYoutubeFolded(false);
    toast(`${padNo(it.no)} 유튜브 영상이 추가되었습니다`);
  };

  const addComment = (id: string, text: string, options: { secret: boolean; folded: boolean; parentId?: string }) => {
    // 로드비 댓글은 로그인 회원 전용. UI뿐 아니라 저장 함수에서도 한 번 더 막는다.
    if (!user) { toast('댓글은 로그인 후 작성할 수 있습니다'); return; }
    const base = { id: newId(), text, date: new Date().toISOString(), target: 'road' as const, targetId: id };
    const c: CommentRow = { ...base, author: user.nickname, authorId: user.id, ...options };
    setCmtRows([...cmtRows, c]);
    // 알림 (4.13) — 그림 작성자에게 (본인 댓글 제외)
    const target = items.find(it => it.id === id);
    const parent = options.parentId ? commentsFor(cmtRows, 'road', id, target?.comments ?? []).find(c => c.id === options.parentId) : undefined;
    const notifyUserId = parent?.authorId || target?.authorId;
    if (target && notifyUserId && notifyUserId !== (user?.id ?? '')) {
      pushNotif({
        type: 'comment', toUserId: notifyUserId, href: '/roadview',
        title: `${padNo(target.no)}에 새 ${options.parentId ? '답글' : '댓글'}`,
        body: options.secret ? `${c.author} — 🔒 비밀 댓글` : `${c.author} — ${text.slice(0, 50)}`,
      });
    }
  };

  // 댓글 수정·삭제 (v1.9) — 로그인 작성자 본인은 수정, 관리자는 삭제 가능.
  // 기존 게스트 댓글은 열람 호환만 유지하며 새 게스트 댓글 작성은 허용하지 않는다.
  // 분리 저장분과 옛 항목 안의 댓글을 모두 다룬다 (v2.0)
  const editComment = (id: string, cid: string, text: string) => {
    if (cmtRows.some(c => c.id === cid)) setCmtRows(cmtRows.map(c => (c.id === cid ? { ...c, text } : c)));
    else setItems(items.map(it => it.id === id ? { ...it, comments: it.comments.map(c => c.id === cid ? { ...c, text } : c) } : it));
  };
  const deleteComment = (id: string, cid: string) => {
    setCmtRows(cmtRows.filter(c => c.id !== cid && c.parentId !== cid));
    setItems(items.map(it => it.id === id
      ? { ...it, comments: it.comments.filter(c => c.id !== cid && c.parentId !== cid) } : it));
  };
  /* 수정은 작성자 본인만 — 관리자도 타인 댓글은 삭제만 (v1.9 사용자 확정).
     **손님 댓글은 손댈 수 없다** (v2.0 사용자 확정) — 비밀번호로 본인을 확인하던 길을
     없앴다. 서버가 로그인한 사람에게만 수정·삭제를 허용하므로 실제로 되지 않던 기능이다. */
  const editLevel = (c: Comment): 'free' | null => (user && c.authorId === user.id ? 'free' : null);
  const delLevel = (c: Comment): 'free' | null => (isAdmin || (user && c.authorId === user.id) ? 'free' : null);

  const visible = items.filter(it => !q || it.author.includes(q)
    || padNo(it.no).includes(q) || String(it.no ?? '').includes(q));

  return (
    <section className="page">
      <div className="page-head">
        <PageTitle>{sec.id === 'main' ? 'LOAD-B' : sec.name}</PageTitle>
        <EditableDesc k="roadview-desc" def="그림이 좋아서 모았습니다" />
        <div className="head-actions">
          {allow(menuSet.roadUpload) && !!user && (
            <>
              <input ref={fileRef} type="file" accept="image/*" style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) { setPendingUpload(f); setUploadSecret(false); setUploadFolded(false); } e.target.value = ''; }} />
              <button className="btn btn-dark" onClick={() => fileRef.current?.click()}
                {...fileDrop(fl => { if (fl[0]) { setPendingUpload(fl[0]); setUploadSecret(false); setUploadFolded(false); } })}>↑ UPLOAD</button>
              <button className="btn btn-ghost" onClick={() => setYoutubeOpen(true)}>▶ YOUTUBE</button>
            </>
          )}
          <SearchBar onSearch={setQ} />
        </div>
      </div>

      {visible.slice(0, shown).map(it => (
        <RoadBlock key={it.id} item={it} comments={commentsFor(cmtRows, 'road', it.id, it.comments)} onComment={addComment}
          onEditComment={editComment} onDeleteComment={deleteComment}
          canComment={allow(menuSet.roadComment) && !!user}
          viewerId={user?.id} isAdmin={isAdmin} adminIds={adminIds}
          editLevel={editLevel} delLevel={delLevel}
          /* authorId 없는 항목 + 비로그인이면 둘 다 undefined라 통과하던 것 (v2.0 발견) —
             손님이 올린 것은 이제 관리자만 손댈 수 있다(손님 확인 수단이 없다) */
          canEditItem={!!it.authorId && it.authorId === user?.id}
          canDeleteItem={isAdmin || (!!it.authorId && it.authorId === user?.id)}
          onEdit={() => {
            setEditFor(it);
            setENo(String(it.no ?? ''));
            setEAdult(it.fold?.type === 'adult');
            setESecret(!!it.secret || it.visibility === 'private');
            setEMediaFolded(!!it.mediaFolded);
          }}
          onDelete={() => setDelFor(it)} />
      ))}
      {visible.length === 0 && (
        <div className="panel" style={{ textAlign: 'center', padding: 44, fontSize: 13, color: 'var(--faint)' }}>
          그림이 없습니다
        </div>
      )}
      {shown < visible.length && (
        <div style={{ textAlign: 'center', marginTop: 6 }}>
          <button className="btn btn-ghost" style={{ background: 'rgba(255,255,255,.9)' }}
            onClick={() => setShown(s => s + PAGE_SIZE)}>MORE ↓</button>
        </div>
      )}
      {/* 편집 모달 (제목 · 수위 접기) */}
      <Modal open={editFor !== null} onClose={() => setEditFor(null)} small title="그림 편집"
        actions={<>
          <button className="btn btn-ghost" onClick={() => setEditFor(null)}>CANCEL</button>
          <button className="btn btn-dark" onClick={() => {
            const nv = parseInt(eNo, 10);
            setItems(items.map(x => x.id === editFor!.id
              ? { ...x, no: Number.isFinite(nv) && nv > 0 ? nv : x.no, fold: eAdult ? { type: 'adult' } : null,
                visibility: 'public', secret: eSecret, mediaFolded: eMediaFolded } : x));
            setEditFor(null);
          }}>SAVE</button>
        </>}>
        <div style={{ display: 'grid', gap: 9 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="cp-lb">번호</span>
            <KInput value={eNo} onChange={e => setENo(e.target.value.replace(/[^\d]/g, ''))}
              style={{ width: 90, textAlign: 'center' }} />
          </div>
          <KCheck label="수위 주의 접기 (블러 + 클릭 표시)" checked={eAdult} onChange={setEAdult} />
          <KCheck label="그라데이션 미리보기로 접기 (OPEN으로 펼침)" checked={eMediaFolded} onChange={setEMediaFolded} />
          <KCheck label="비밀 업로드 (작성자와 관리자만 열람)" checked={eSecret} onChange={setESecret} />
        </div>
      </Modal>

      <Modal open={pendingUpload !== null} onClose={() => { setPendingUpload(null); setUploadSecret(false); setUploadFolded(false); }} small
        title="로드비 업로드" desc={pendingUpload?.name}
        actions={<>
          <button className="btn btn-ghost" onClick={() => { setPendingUpload(null); setUploadSecret(false); setUploadFolded(false); }}>CANCEL</button>
          <button className="btn btn-dark" onClick={() => upload(pendingUpload ?? undefined, uploadSecret, uploadFolded)}>UPLOAD</button>
        </>}>
        <div style={{ display: 'grid', gap: 9 }}>
          <KCheck label="접어서 올리기 (다른 사람도 처음엔 접힌 상태)" checked={uploadFolded} onChange={setUploadFolded} />
          <KCheck label="비밀 업로드 (작성자와 관리자만 열람)" checked={uploadSecret} onChange={setUploadSecret} />
        </div>
      </Modal>

      {/* 삭제 경고 모달 */}
      <ConfirmModal open={delFor !== null} title="그림을 삭제하시겠습니까?"
        body={`${padNo(delFor?.no)} — 삭제한 그림과 댓글은 복구할 수 없습니다.`}
        onClose={() => setDelFor(null)}
        buttons={[
          { label: 'DELETE', kind: 'accent', onClick: () => {
            const gone = delFor!.id;
            setItems(compactNumbers(items.filter(x => x.id !== gone)));
            // 그림에 딸린 댓글도 함께 (v2.0 — 따로 저장이라 남겨 두면 주인 없는 줄이 된다)
            setCmtRows(cmtRows.filter(c => !(c.target === 'road' && c.targetId === gone)));
            setDelFor(null);
          } },
          { label: 'CANCEL', kind: 'ghost', onClick: () => setDelFor(null) },
        ]} />

      <Modal open={youtubeOpen} onClose={() => { setYoutubeOpen(false); setYoutubeUrl(''); setYoutubeSecret(false); setYoutubeFolded(false); }} small
        title="유튜브 영상 추가" desc="일반 영상, youtu.be 단축 주소, Shorts 링크를 사용할 수 있습니다."
        actions={<>
          <button className="btn btn-ghost" onClick={() => { setYoutubeOpen(false); setYoutubeUrl(''); setYoutubeSecret(false); setYoutubeFolded(false); }}>CANCEL</button>
          <button className="btn btn-dark" disabled={!youtubeUrl.trim()} onClick={uploadYoutube}>ADD</button>
        </>}>
        <KInput autoFocus value={youtubeUrl} placeholder="https://youtu.be/..."
          onChange={e => setYoutubeUrl(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') uploadYoutube(); }} />
        <div style={{ marginTop: 12, display: 'grid', gap: 9 }}>
          <KCheck label="접어서 올리기 (다른 사람도 처음엔 접힌 상태)" checked={youtubeFolded} onChange={setYoutubeFolded} />
          <KCheck label="비밀 업로드 (작성자와 관리자만 열람)" checked={youtubeSecret} onChange={setYoutubeSecret} />
        </div>
      </Modal>
    </section>
  );
}

/** ?s= 를 읽으므로 Suspense 경계가 필요하다 (Next App Router) */
export default function RoadviewPage() {
  return <Suspense fallback={<section className="page" />}><RoadviewPageInner /></Suspense>;
}
