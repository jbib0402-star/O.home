'use client';

import { useMemo, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { RoadItem, ROAD_SEED } from '@/lib/galleryStore';
import { useLocalList, newId, fmtDate } from '@/lib/postStore';
import { filterSection, sectionSetter } from '@/lib/sectionStore';
import { youtubeVideoId } from '@/lib/youtube';
import { useMenuSettings, MenuPerm } from '@/lib/menuStore';
import { KInput, KTextarea, SearchBar } from '@/components/ui/Kit';
import { Modal, ConfirmModal } from '@/components/ui/Modal';
import { EditableDesc, PageTitle } from '@/components/ui/PageText';
import { useToast } from '@/components/ui/Toast';

const MUSIC_SEC = '__music__';

type Draft = { url: string; title: string; artist: string; note: string };
const EMPTY: Draft = { url: '', title: '', artist: '', note: '' };

export default function MusicPage() {
  const { user, isAdmin } = useAuth();
  const toast = useToast();
  const [menuSet] = useMenuSettings();
  const [all, setAll] = useLocalList<RoadItem>('ohome.road.v1', ROAD_SEED);
  const items = filterSection(all, MUSIC_SEC).filter(it => it.music && !!it.youtubeId)
    .sort((a, b) => b.date.localeCompare(a.date));
  const setItems = sectionSetter(all, MUSIC_SEC, setAll);
  const [query, setQuery] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<RoadItem | null>(null);
  const [deleting, setDeleting] = useState<RoadItem | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const allow = (p: MenuPerm) => (p === 'admin' ? isAdmin : p === 'member' ? !!user : true);
  const canAdd = !!user && allow(menuSet.roadUpload);
  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return items;
    return items.filter(it => [it.title, it.artist, it.note].some(v => v?.toLocaleLowerCase().includes(q)));
  }, [items, query]);

  const startAdd = () => {
    setEditing(null);
    setDraft(EMPTY);
    setModalOpen(true);
  };
  const startEdit = (item: RoadItem) => {
    setEditing(item);
    setDraft({
      url: item.youtubeId ? `https://youtu.be/${item.youtubeId}` : '',
      title: item.title,
      artist: item.artist ?? '',
      note: item.note ?? '',
    });
    setModalOpen(true);
  };
  const closeModal = () => { setModalOpen(false); setEditing(null); setDraft(EMPTY); };
  const save = () => {
    const youtubeId = youtubeVideoId(draft.url);
    if (!youtubeId) { toast('올바른 유튜브 링크를 입력해 주세요'); return; }
    if (!draft.title.trim()) { toast('곡 제목을 입력해 주세요'); return; }
    if (editing) {
      setItems(items.map(it => it.id === editing.id ? {
        ...it, youtubeId, title: draft.title.trim(), artist: draft.artist.trim(), note: draft.note.trim(),
      } : it));
      toast('곡 정보를 수정했습니다');
    } else {
      const item: RoadItem = {
        id: newId(), secId: MUSIC_SEC, music: true,
        title: draft.title.trim(), artist: draft.artist.trim(), note: draft.note.trim(), youtubeId,
        author: user!.nickname, authorId: user!.id, date: new Date().toISOString(),
        ph: '', ratio: '16 / 9', fold: null, comments: [], visibility: 'public',
      };
      setItems([item, ...items]);
      toast('노래를 추가했습니다');
    }
    closeModal();
  };

  return (
    <section className="page music-page">
      <div className="page-head">
        <PageTitle>MUSIC</PageTitle>
        <EditableDesc k="music-desc" def="좋아하는 노래를 모았습니다" />
        <div className="head-actions">
          {canAdd && <button className="btn btn-dark" onClick={startAdd}>＋ ADD SONG</button>}
          <SearchBar onSearch={setQuery} />
        </div>
      </div>

      <div className="panel music-list">
        {visible.map(item => {
          const expanded = openId === item.id;
          const canEdit = !!item.authorId && item.authorId === user?.id;
          const canDelete = isAdmin || canEdit;
          return (
            <article className={`music-item ${expanded ? 'open' : ''}`} key={item.id}>
              <button className="music-summary" type="button" aria-expanded={expanded}
                aria-controls={`music-player-${item.id}`}
                onClick={() => setOpenId(expanded ? null : item.id)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`https://i.ytimg.com/vi/${item.youtubeId}/mqdefault.jpg`} alt="" />
                <span className="music-copy">
                  <b>{item.title}</b>
                  {item.artist && <span>{item.artist}</span>}
                  {item.note && <small>{item.note}</small>}
                </span>
                <span className="music-play" aria-hidden="true">{expanded ? '×' : '▶'}</span>
              </button>
              {expanded && (
                <div className="music-player" id={`music-player-${item.id}`}>
                  <iframe src={`https://www.youtube-nocookie.com/embed/${item.youtubeId}?rel=0&autoplay=1`}
                    title={`${item.title} 재생`} allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                    referrerPolicy="strict-origin-when-cross-origin" allowFullScreen />
                  <div className="music-meta">
                    <span>{item.author} · {fmtDate(item.date)}</span>
                    {(canEdit || canDelete) && <span className="music-actions">
                      {canEdit && <button onClick={() => startEdit(item)}>EDIT</button>}
                      {canDelete && <button onClick={() => setDeleting(item)}>DELETE</button>}
                    </span>}
                  </div>
                </div>
              )}
            </article>
          );
        })}
        {visible.length === 0 && <div className="music-empty">등록된 노래가 없습니다</div>}
      </div>

      <Modal open={modalOpen} onClose={closeModal} small title={editing ? '노래 수정' : '노래 추가'}
        desc="유튜브 일반·단축·Shorts 링크를 사용할 수 있습니다."
        actions={<>
          <button className="btn btn-ghost" onClick={closeModal}>CANCEL</button>
          <button className="btn btn-dark" onClick={save}>SAVE</button>
        </>}>
        <div className="music-form">
          <label><span>YOUTUBE LINK</span><KInput autoFocus value={draft.url} placeholder="https://youtu.be/..."
            onChange={e => setDraft(v => ({ ...v, url: e.target.value }))} /></label>
          <label><span>SONG</span><KInput value={draft.title} placeholder="곡 제목"
            onChange={e => setDraft(v => ({ ...v, title: e.target.value }))} /></label>
          <label><span>ARTIST</span><KInput value={draft.artist} placeholder="아티스트"
            onChange={e => setDraft(v => ({ ...v, artist: e.target.value }))} /></label>
          <label><span>MEMO</span><KTextarea rows={2} value={draft.note} placeholder="짧은 메모 (선택)"
            onChange={e => setDraft(v => ({ ...v, note: e.target.value }))} /></label>
        </div>
      </Modal>

      <ConfirmModal open={deleting !== null} title="노래를 삭제하시겠습니까?"
        body={deleting?.title ?? ''} onClose={() => setDeleting(null)}
        buttons={[
          { label: 'DELETE', kind: 'accent', onClick: () => {
            const id = deleting!.id;
            setItems(items.filter(it => it.id !== id));
            if (openId === id) setOpenId(null);
            setDeleting(null);
          } },
          { label: 'CANCEL', kind: 'ghost', onClick: () => setDeleting(null) },
        ]} />
    </section>
  );
}
