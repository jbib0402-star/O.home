import { youtubeVideoId } from '@/lib/youtube';

export async function GET(request: Request) {
  const id = youtubeVideoId(new URL(request.url).searchParams.get('id') ?? '');
  if (!id) return Response.json({ error: 'invalid_video' }, { status: 400 });

  const videoUrl = `https://www.youtube.com/watch?v=${id}`;
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoUrl)}&format=json`;
  try {
    const response = await fetch(endpoint, { next: { revalidate: 86400 } });
    if (!response.ok) return Response.json({ error: 'metadata_unavailable' }, { status: 404 });
    const data = await response.json() as { title?: string; author_name?: string };
    return Response.json({ title: data.title ?? '', author: data.author_name ?? '' });
  } catch {
    return Response.json({ error: 'metadata_unavailable' }, { status: 502 });
  }
}
