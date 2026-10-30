import { NextRequest, NextResponse } from 'next/server';

const ALLOWED_BUCKETS = new Set([
  'popoto-a3aa1.firebasestorage.app',
  'popoto-a3aa1.appspot.com',
]);
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Firebase → Supabase 이전 중에만 쓰는 제한 프록시.
 * Firebase Storage의 CORS 때문에 브라우저 fetch가 막힐 때,
 * 기존 O.home 버킷의 공개 파일만 서버에서 받아 전달한다.
 */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('url');
  if (!raw) return NextResponse.json({ error: 'missing url' }, { status: 400 });

  let url: URL;
  try { url = new URL(raw); }
  catch { return NextResponse.json({ error: 'invalid url' }, { status: 400 }); }

  if (url.protocol !== 'https:' || url.hostname !== 'firebasestorage.googleapis.com') {
    return NextResponse.json({ error: 'host not allowed' }, { status: 403 });
  }

  const m = url.pathname.match(/^\/v0\/b\/([^/]+)\/o\//);
  const bucket = m?.[1] ? decodeURIComponent(m[1]) : '';
  if (!ALLOWED_BUCKETS.has(bucket)) {
    return NextResponse.json({ error: 'bucket not allowed' }, { status: 403 });
  }

  const upstream = await fetch(url.toString(), { cache: 'no-store', redirect: 'follow' });
  if (!upstream.ok) {
    return NextResponse.json({ error: 'upstream failed' }, { status: upstream.status });
  }

  const declared = Number(upstream.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) {
    return NextResponse.json({ error: 'file too large' }, { status: 413 });
  }

  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_BYTES) {
    return NextResponse.json({ error: 'file too large' }, { status: 413 });
  }

  return new NextResponse(body, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'private, no-store',
      'content-length': String(body.byteLength),
    },
  });
}
