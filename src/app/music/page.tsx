'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
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
import { putBlob, useBlobUrl } from '@/lib/blobStore';

const MUSIC_SEC = '__music__';
const QUICK_KEY = 'ohome.quickmusic.v1';
const QUICK_META_KEY = 'ohome.quickmusic.meta.v1';
const DAY = 24 * 60 * 60 * 1000;
type QuickMeta = { title: string; bgId?: string; expiresAt?: string };
type Draft = { url: string; title: string; artist: string; note: string };
type RepeatMode = 'none' | 'one' | 'all';
type YTState = { data: number };
type YTPlayer = {
  loadVideoById: (id: string) => void; cueVideoById: (id: string) => void;
  playVideo: () => void; pauseVideo: () => void; stopVideo: () => void;
  getCurrentTime: () => number; getDuration: () => number;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  setVolume: (volume: number) => void; destroy: () => void;
};
const EMPTY: Draft = { url: '', title: '', artist: '', note: '' };
const clamp = (n: number) => Math.max(0, Number.isFinite(n) ? n : 0);
const clock = (seconds: number) => {
  const s = Math.floor(clamp(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function MusicPlayerPage({ temporary = false }: { temporary?: boolean }) {
  const { user, isAdmin } = useAuth();
  const toast = useToast();
  const [menuSet] = useMenuSettings();
  const [all, setAll] = useLocalList<RoadItem>(temporary ? QUICK_KEY : 'ohome.road.v1', ROAD_SEED);
  const source = temporary ? all : filterSection(all, MUSIC_SEC);
  const items = source.filter(it => it.music && !!it.youtubeId)
    .sort((a, b) => (a.musicOrder ?? Number.MAX_SAFE_INTEGER) - (b.musicOrder ?? Number.MAX_SAFE_INTEGER)
      || b.date.localeCompare(a.date));
  const setItems = temporary ? setAll : sectionSetter(all, MUSIC_SEC, setAll);
  const [query, setQuery] = useState('');
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolumeState] = useState(80);
  const [repeat, setRepeat] = useState<RepeatMode>('none');
  const [shuffle, setShuffle] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<RoadItem | null>(null);
  const [deleting, setDeleting] = useState<RoadItem | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [quickMeta, setQuickMeta] = useState<QuickMeta>({ title: 'ONE-DAY PLAYLIST' });
  const [quickSettings, setQuickSettings] = useState(false);
  const [quickClear, setQuickClear] = useState(false);
  const [quickTitle, setQuickTitle] = useState('ONE-DAY PLAYLIST');
  const [now, setNow] = useState(Date.now());
  const quickFileRef = useRef<HTMLInputElement>(null);
  const quickBg = useBlobUrl(temporary ? quickMeta.bgId : undefined);
  const playerRef = useRef<YTPlayer | null>(null);
  const itemsRef = useRef(items);
  const currentRef = useRef(currentId);
  const repeatRef = useRef(repeat);
  const shuffleRef = useRef(shuffle);
  itemsRef.current = items;
  currentRef.current = currentId;
  repeatRef.current = repeat;
  shuffleRef.current = shuffle;

  useEffect(() => {
    if (!temporary) return;
    try {
      const raw = localStorage.getItem(QUICK_META_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as QuickMeta;
        setQuickMeta(parsed);
        setQuickTitle(parsed.title || 'ONE-DAY PLAYLIST');
      }
    } catch { /* 기본값 */ }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [temporary]);

  useEffect(() => {
    if (!temporary || !quickMeta.expiresAt || new Date(quickMeta.expiresAt).getTime() > now) return;
    setAll([]);
    const clean = { title: quickMeta.title || 'ONE-DAY PLAYLIST', bgId: quickMeta.bgId };
    setQuickMeta(clean);
    try { localStorage.setItem(QUICK_META_KEY, JSON.stringify(clean)); } catch { /* 무시 */ }
    playerRef.current?.stopVideo();
    setCurrentId(null);
  }, [temporary, quickMeta, now, setAll]);

  const saveQuickMeta = (next: QuickMeta) => {
    setQuickMeta(next);
    try { localStorage.setItem(QUICK_META_KEY, JSON.stringify(next)); } catch { /* 무시 */ }
  };
  const timeLeft = quickMeta.expiresAt ? Math.max(0, new Date(quickMeta.expiresAt).getTime() - now) : 0;
  const timeLeftText = quickMeta.expiresAt
    ? `${String(Math.floor(timeLeft / 3600000)).padStart(2, '0')}:${String(Math.floor(timeLeft / 60000) % 60).padStart(2, '0')}:${String(Math.floor(timeLeft / 1000) % 60).padStart(2, '0')}`
    : '첫 곡 추가 후 24:00:00';

  const allow = (p: MenuPerm) => (p === 'admin' ? isAdmin : p === 'member' ? !!user : true);
  const canAdd = !!user && allow(menuSet.roadUpload);
  const current = items.find(it => it.id === currentId) ?? items[0] ?? null;
  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    if (!q) return items;
    return items.filter(it => [it.title, it.artist, it.note].some(v => v?.toLocaleLowerCase().includes(q)));
  }, [items, query]);

  useEffect(() => {
    if (!items.length) { setCurrentId(null); return; }
    if (!currentId || !items.some(it => it.id === currentId)) setCurrentId(items[0].id);
  }, [items, currentId]);

  const moveTrack = useCallback((direction: 1 | -1, autoplay = true) => {
    const list = itemsRef.current;
    if (!list.length) return;
    const now = list.findIndex(it => it.id === currentRef.current);
    let next = now;
    if (shuffleRef.current && list.length > 1) {
      do { next = Math.floor(Math.random() * list.length); } while (next === now);
    } else {
      next = now + direction;
      if (next < 0 || next >= list.length) {
        if (repeatRef.current !== 'all') { playerRef.current?.stopVideo(); setPlaying(false); return; }
        next = next < 0 ? list.length - 1 : 0;
      }
    }
    const track = list[next] ?? list[0];
    setCurrentId(track.id);
    currentRef.current = track.id;
    if (autoplay) playerRef.current?.loadVideoById(track.youtubeId!);
    else playerRef.current?.cueVideoById(track.youtubeId!);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const init = () => {
      if (cancelled || playerRef.current || !window.YT || !current?.youtubeId) return;
      const mount = document.getElementById('music-youtube-player');
      if (!mount) return;
      playerRef.current = new window.YT.Player(mount, {
        videoId: current.youtubeId,
        playerVars: { rel: 0, playsinline: 1, controls: 1 },
        events: {
          onReady: () => {
            if (cancelled) return;
            setReady(true);
            playerRef.current?.setVolume(volume);
          },
          onStateChange: (event: YTState) => {
            if (!window.YT) return;
            if (event.data === window.YT.PlayerState.PLAYING) setPlaying(true);
            if (event.data === window.YT.PlayerState.PAUSED) setPlaying(false);
            if (event.data === window.YT.PlayerState.ENDED) {
              if (repeatRef.current === 'one' && currentRef.current) {
                const same = itemsRef.current.find(it => it.id === currentRef.current);
                if (same?.youtubeId) playerRef.current?.loadVideoById(same.youtubeId);
              } else moveTrack(1);
            }
          },
        },
      });
    };
    if (window.YT?.Player) init();
    else {
      const prior = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prior?.(); init(); };
      if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
        const script = document.createElement('script');
        script.src = 'https://www.youtube.com/iframe_api';
        script.async = true;
        document.head.appendChild(script);
      }
    }
    return () => { cancelled = true; };
    // 플레이어는 최초 곡으로 한 번만 만든 뒤 API로 곡을 교체한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!current]);

  useEffect(() => {
    if (!ready || !playing) return;
    const timer = window.setInterval(() => {
      setElapsed(clamp(playerRef.current?.getCurrentTime() ?? 0));
      setDuration(clamp(playerRef.current?.getDuration() ?? 0));
    }, 500);
    return () => window.clearInterval(timer);
  }, [ready, playing]);

  useEffect(() => () => { playerRef.current?.destroy(); playerRef.current = null; }, []);

  const selectTrack = (item: RoadItem) => {
    setCurrentId(item.id);
    currentRef.current = item.id;
    setElapsed(0);
    setDuration(0);
    playerRef.current?.loadVideoById(item.youtubeId!);
  };
  const togglePlay = () => playing ? playerRef.current?.pauseVideo() : playerRef.current?.playVideo();
  const changeVolume = (next: number) => { setVolumeState(next); playerRef.current?.setVolume(next); };
  const cycleRepeat = () => setRepeat(v => v === 'none' ? 'one' : v === 'one' ? 'all' : 'none');
  const repeatLabel = repeat === 'one' ? '한 곡 반복' : repeat === 'all' ? '전체 반복' : '반복 없음';

  const startAdd = () => { setEditing(null); setDraft(EMPTY); setModalOpen(true); };
  const startEdit = (item: RoadItem) => {
    setEditing(item);
    setDraft({ url: item.youtubeId ? `https://youtu.be/${item.youtubeId}` : '', title: item.title, artist: item.artist ?? '', note: item.note ?? '' });
    setModalOpen(true);
  };
  const closeModal = () => { setModalOpen(false); setEditing(null); setDraft(EMPTY); };
  const save = () => {
    const youtubeId = youtubeVideoId(draft.url);
    if (!youtubeId) { toast('올바른 유튜브 링크를 입력해 주세요'); return; }
    if (!draft.title.trim()) { toast('곡 제목을 입력해 주세요'); return; }
    if (editing) {
      setItems(items.map(it => it.id === editing.id ? { ...it, youtubeId, title: draft.title.trim(), artist: draft.artist.trim(), note: draft.note.trim() } : it));
      if (editing.id === currentId) playerRef.current?.cueVideoById(youtubeId);
      toast('곡 정보를 수정했습니다');
    } else {
      const expiresAt = temporary
        ? (quickMeta.expiresAt ?? new Date(Date.now() + DAY).toISOString())
        : undefined;
      const item: RoadItem = {
        id: newId(), ...(temporary ? {} : { secId: MUSIC_SEC }), music: true, musicOrder: items.length,
        title: draft.title.trim(), artist: draft.artist.trim(), note: draft.note.trim(), youtubeId,
        author: user!.nickname, authorId: user!.id, date: new Date().toISOString(),
        ph: '', ratio: '16 / 9', fold: null, comments: [], visibility: 'public',
      };
      // 구형 곡은 순서 필드가 없으므로, 새 곡을 붙일 때 현재 표시 순서도 함께 확정한다.
      setItems([...items.map((it, index) => ({ ...it, musicOrder: index })), item]);
      if (temporary && expiresAt !== quickMeta.expiresAt) saveQuickMeta({ ...quickMeta, expiresAt });
      if (!currentId) setCurrentId(item.id);
      toast('재생목록에 노래를 추가했습니다');
    }
    closeModal();
  };

  const reorder = (targetId: string) => {
    if (!isAdmin || !dragId || dragId === targetId) { setDragId(null); return; }
    const next = [...items];
    const from = next.findIndex(it => it.id === dragId);
    const to = next.findIndex(it => it.id === targetId);
    if (from < 0 || to < 0) return;
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setItems(next.map((it, index) => ({ ...it, musicOrder: index })));
    setDragId(null);
  };

  return (
    <section className={`page music-page ${temporary ? 'quick-music-page' : ''}`}
      style={temporary && quickBg ? { '--quick-bg': `url("${quickBg}")` } as CSSProperties : undefined}>
      <div className="page-head music-page-head">
        <PageTitle>{temporary ? quickMeta.title : 'MUSIC'}</PageTitle>
        {temporary ? <p className="quick-expiry">24H TEMPORARY · 남은 시간 {timeLeftText}</p>
          : <EditableDesc k="music-desc" def="좋아하는 노래를 모았습니다" />}
        {temporary && isAdmin && <div className="head-actions">
          <button className="btn btn-ghost" onClick={() => { setQuickTitle(quickMeta.title); setQuickSettings(true); }}>PLAYLIST SETTING</button>
          <button className="btn btn-ghost" disabled={!items.length} onClick={() => setQuickClear(true)}>EMPTY</button>
        </div>}
      </div>

      <div className="panel music-deck">
        <div className="music-screen"><div id="music-youtube-player" /></div>
        <div className="music-now">
          {current ? <>
            <span className="music-eyebrow">● NOW PLAYING</span>
            <h2>{current.title}</h2>
            {current.artist && <p>{current.artist}</p>}
            {current.note && <small>{current.note}</small>}
            <div className="music-progress-row">
              <input aria-label="재생 위치" type="range" min={0} max={Math.max(duration, 1)} step={1} value={Math.min(elapsed, Math.max(duration, 1))}
                onChange={e => { const v = Number(e.target.value); setElapsed(v); playerRef.current?.seekTo(v, true); }} />
              <span>{clock(elapsed)} / {clock(duration)}</span>
            </div>
            <div className="music-controls">
              <button aria-label="이전 곡" onClick={() => moveTrack(-1)}>│◀</button>
              <button className="primary" aria-label={playing ? '일시정지' : '재생'} onClick={togglePlay}>{playing ? 'Ⅱ' : '▶'}</button>
              <button aria-label="다음 곡" onClick={() => moveTrack(1)}>▶│</button>
              <label className="music-volume">♪<input aria-label="음량" type="range" min={0} max={100} value={volume}
                onChange={e => changeVolume(Number(e.target.value))} /><span>{volume}</span></label>
            </div>
            <div className="music-modes">
              <button className={repeat !== 'none' ? 'on' : ''} onClick={cycleRepeat}>↻ {repeatLabel}</button>
              <button className={shuffle ? 'on' : ''} onClick={() => setShuffle(v => !v)}>⌘ 랜덤</button>
            </div>
          </> : <div className="music-player-empty"><b>재생목록이 비어 있습니다</b><span>유튜브 주소로 노래를 추가해 주세요</span></div>}
        </div>
      </div>

      <div className="panel music-list">
        <div className="music-list-head">
          <div><b>PLAYLIST</b><span>{items.length} SONGS</span></div>
          <div className="music-list-tools">
            {canAdd && <button className="btn btn-dark" onClick={startAdd}>＋ ADD SONG</button>}
            <SearchBar onSearch={setQuery} />
          </div>
        </div>
        {visible.map(item => {
          const active = current?.id === item.id;
          const canEdit = !!item.authorId && item.authorId === user?.id;
          const canDelete = isAdmin || canEdit;
          return (
            <article className={`music-item ${active ? 'active' : ''}`} key={item.id}
              draggable={isAdmin} onDragStart={() => setDragId(item.id)} onDragEnd={() => setDragId(null)}
              onDragOver={e => { if (isAdmin) e.preventDefault(); }} onDrop={() => reorder(item.id)}>
              {isAdmin && <span className="music-grip" aria-label="순서 변경">⠿</span>}
              <button className="music-summary" type="button" onClick={() => selectTrack(item)}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`https://i.ytimg.com/vi/${item.youtubeId}/mqdefault.jpg`} alt="" />
                <span className="music-copy"><b>{item.title}</b>{item.artist && <span>{item.artist}</span>}{item.note && <small>{item.note}</small>}</span>
              </button>
              {active && <span className="music-playing-badge">NOW PLAYING</span>}
              <span className="music-row-date">{fmtDate(item.date)}</span>
              {(canEdit || canDelete) && <span className="music-actions">
                {canEdit && <button onClick={() => startEdit(item)}>EDIT</button>}
                {canDelete && <button onClick={() => setDeleting(item)}>DELETE</button>}
              </span>}
            </article>
          );
        })}
        {visible.length === 0 && <div className="music-empty">등록된 노래가 없습니다</div>}
      </div>

      <Modal open={modalOpen} onClose={closeModal} small title={editing ? '노래 수정' : '노래 추가'}
        desc="유튜브 일반·단축·Shorts 링크를 사용할 수 있습니다."
        actions={<><button className="btn btn-ghost" onClick={closeModal}>CANCEL</button><button className="btn btn-dark" onClick={save}>SAVE</button></>}>
        <div className="music-form">
          <label><span>YOUTUBE LINK</span><KInput autoFocus value={draft.url} placeholder="https://youtu.be/..." onChange={e => setDraft(v => ({ ...v, url: e.target.value }))} /></label>
          <label><span>SONG</span><KInput value={draft.title} placeholder="곡 제목" onChange={e => setDraft(v => ({ ...v, title: e.target.value }))} /></label>
          <label><span>ARTIST</span><KInput value={draft.artist} placeholder="아티스트 (선택)" onChange={e => setDraft(v => ({ ...v, artist: e.target.value }))} /></label>
          <label><span>MEMO</span><KTextarea rows={2} value={draft.note} placeholder="짧은 메모 (선택)" onChange={e => setDraft(v => ({ ...v, note: e.target.value }))} /></label>
        </div>
      </Modal>

      {temporary && <Modal open={quickSettings} onClose={() => setQuickSettings(false)} small title="임시 플레이리스트 설정"
        desc="배경 이미지는 이 브라우저의 임시 플레이리스트에만 적용됩니다."
        actions={<><button className="btn btn-ghost" onClick={() => setQuickSettings(false)}>CANCEL</button>
          <button className="btn btn-dark" onClick={() => { saveQuickMeta({ ...quickMeta, title: quickTitle.trim() || 'ONE-DAY PLAYLIST' }); setQuickSettings(false); }}>SAVE</button></>}>
        <div className="music-form">
          <label><span>TITLE</span><KInput value={quickTitle} onChange={e => setQuickTitle(e.target.value)} /></label>
          <label><span>BACKGROUND</span>
            <input ref={quickFileRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={async e => {
              const file = e.target.files?.[0]; e.target.value = ''; if (!file) return;
              const bgId = await putBlob(file); saveQuickMeta({ ...quickMeta, bgId });
            }} />
            <button className="btn btn-ghost" onClick={() => quickFileRef.current?.click()}>IMAGE UPLOAD</button>
          </label>
        </div>
      </Modal>}

      {temporary && <ConfirmModal open={quickClear} title="임시 플레이리스트를 비울까요?"
        body="등록한 곡과 남은 시간이 초기화됩니다." onClose={() => setQuickClear(false)}
        buttons={[
          { label: 'EMPTY', kind: 'accent', onClick: () => {
            setItems([]); saveQuickMeta({ title: quickMeta.title, bgId: quickMeta.bgId });
            playerRef.current?.stopVideo(); setCurrentId(null); setQuickClear(false);
          } },
          { label: 'CANCEL', kind: 'ghost', onClick: () => setQuickClear(false) },
        ]} />}

      <ConfirmModal open={deleting !== null} title="노래를 삭제하시겠습니까?" body={deleting?.title ?? ''} onClose={() => setDeleting(null)}
        buttons={[
          { label: 'DELETE', kind: 'accent', onClick: () => {
            const id = deleting!.id;
            const next = items.filter(it => it.id !== id).map((it, index) => ({ ...it, musicOrder: index }));
            setItems(next);
            if (currentId === id) {
              playerRef.current?.stopVideo();
              setCurrentId(next[0]?.id ?? null);
              if (next[0]?.youtubeId) playerRef.current?.cueVideoById(next[0].youtubeId);
            }
            setDeleting(null);
          } },
          { label: 'CANCEL', kind: 'ghost', onClick: () => setDeleting(null) },
        ]} />
    </section>
  );
}

export default function MusicPage() {
  return <MusicPlayerPage />;
}
