'use client';

import { useAuth } from '@/lib/auth';
import { MusicPlayerPage } from '@/app/music/page';

export default function QuickMusicPage() {
  const { user, ready } = useAuth();
  if (!ready) return <section className="page" />;
  if (!user) return <section className="page"><div className="panel quick-denied">로그인한 회원만 사용할 수 있는 개인 24H 플레이리스트입니다.</div></section>;
  return <MusicPlayerPage temporary />;
}
