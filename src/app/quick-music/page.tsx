'use client';

import { useAuth } from '@/lib/auth';
import { MusicPlayerPage } from '@/app/music/page';

export default function QuickMusicPage() {
  const { isAdmin, ready } = useAuth();
  if (!ready) return <section className="page" />;
  if (!isAdmin) return <section className="page"><div className="panel quick-denied">관리자 전용 임시 플레이리스트입니다.</div></section>;
  return <MusicPlayerPage temporary />;
}
