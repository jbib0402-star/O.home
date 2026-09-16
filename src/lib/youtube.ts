/** 일반 영상·단축 URL·Shorts·embed·live 주소에서 안전한 11자리 영상 ID만 꺼낸다. */
export function youtubeVideoId(value: string): string | null {
  const raw = value.trim();
  if (/^[\w-]{11}$/.test(raw)) return raw;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    let id = '';
    if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] ?? '';
    else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
      id = url.searchParams.get('v') ?? '';
      if (!id) {
        const parts = url.pathname.split('/').filter(Boolean);
        if (['shorts', 'embed', 'live'].includes(parts[0] ?? '')) id = parts[1] ?? '';
      }
    }
    return /^[\w-]{11}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}
