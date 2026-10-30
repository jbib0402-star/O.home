'use client';
// Supabase 백엔드 — Postgres 테이블(행 단위) + Auth + Storage + Realtime
// 스키마·권한: supabase/schema.sql
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Backend, BackendCheck, BackendConfig, BackendUser, ListItem, diffList, metaOf,
} from './types';
import { visFloorOf } from '../visFloor';

const BUCKET = 'ohome';
const PROBE = ['profiles', 'site_settings', 'posts', 'characters'];

export async function createSupabaseBackend(
  cfg: Extract<BackendConfig, { kind: 'supabase' }>,
): Promise<Backend> {
  const { createBrowserClient } = await import('@supabase/ssr');
  const sb: SupabaseClient = createBrowserClient(cfg.url.replace(/\/$/, ''), cfg.anonKey);

  // Supabase Auth의 비밀번호 로그인은 이메일/전화번호 식별자를 요구한다.
  // O.home에서는 사용자가 이메일 없이 "아이디"만 쓰도록, 일반 아이디를 내부 전용 이메일로
  // 결정적으로 변환한다. 실제 이메일처럼 보이지만 메일 발송에는 쓰지 않는 예약 도메인이다.
  const authEmailFor = async (loginId: string): Promise<string> => {
    const raw = loginId.trim();
    if (raw.includes('@')) return raw; // 기존 이메일 계정(관리자 포함)은 그대로 호환
    const normalized = raw.normalize('NFKC').toLocaleLowerCase();
    const bytes = new TextEncoder().encode(normalized);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest))
      .map(b => b.toString(16).padStart(2, '0')).join('');
    return `u-${hex}@users.ohome.example.com`;
  };

  const toUser = async (u: { id: string; email?: string; user_metadata?: Record<string, unknown> } | null | undefined): Promise<BackendUser | null> => {
    if (!u) return null;
    const { data: prof } = await sb.from('profiles')
      .select('nickname, role, avatar_url, avatar_color').eq('id', u.id).maybeSingle();
    return {
      id: u.id,
      loginId: (u.user_metadata?.login_id as string | undefined) ?? u.email,
      nickname: prof?.nickname ?? (u.user_metadata?.nickname as string) ?? (u.user_metadata?.login_id as string) ?? u.email ?? 'user',
      role: (prof?.role as 'admin' | 'member') ?? 'member',
      email: u.email,
      avatarUrl: prof?.avatar_url ?? undefined,
      avatarColor: prof?.avatar_color ?? undefined,
    };
  };

  return {
    kind: 'supabase',

    async check(): Promise<BackendCheck> {
      const fail = (p: Partial<BackendCheck>): BackendCheck =>
        ({ ok: false, reachable: false, schema: false, hasAdmin: false, message: '', ...p });
      let reachable = false;
      try {
        const { error } = await sb.from('profiles').select('id').limit(1);
        if (error) {
          if (error.code === '42P01' || /does not exist/i.test(error.message)) reachable = true;
          else if (/JWT|api key|Invalid/i.test(error.message)) {
            return fail({ message: 'anon key가 올바르지 않습니다 — Supabase → Settings → API에서 anon public 키를 다시 복사해 주세요.' });
          } else if (/fetch|network|Load failed/i.test(error.message)) {
            return fail({ message: '프로젝트에 닿지 못했습니다 — Project URL이 정확한지, 프로젝트가 일시정지(Paused) 상태는 아닌지 확인해 주세요.' });
          } else return fail({ message: `연결에 실패했습니다 — ${error.message}` });
        } else reachable = true;
      } catch {
        return fail({ message: '프로젝트에 접속할 수 없습니다 — URL을 확인해 주세요.' });
      }

      const missing: string[] = [];
      for (const t of PROBE) {
        const { error } = await sb.from(t).select('*', { head: true, count: 'exact' }).limit(1);
        if (error && (error.code === '42P01' || /does not exist/i.test(error.message))) missing.push(t);
      }
      if (missing.length) {
        return fail({ reachable, message: `스키마가 아직 없습니다 (${missing.join(', ')}) — 아래 SQL을 Supabase의 SQL Editor에서 한 번 실행해 주세요.` });
      }

      const { count } = await sb.from('profiles').select('id', { head: true, count: 'exact' }).eq('role', 'admin');
      const hasAdmin = (count ?? 0) > 0;
      return {
        ok: true, reachable, schema: true, hasAdmin,
        message: hasAdmin ? '연결 완료 — 관리자 계정이 이미 있습니다. 그 계정으로 로그인해 주세요.'
          : '연결 완료 — 이제 관리자 계정을 만들면 됩니다. 첫 번째 가입 계정이 관리자가 됩니다.',
      };
    },

    async currentUser() {
      const { data } = await sb.auth.getUser();
      return toUser(data.user);
    },

    onAuthChange(cb) {
      const { data: sub } = sb.auth.onAuthStateChange((_e, session) => {
        void toUser(session?.user).then(cb);
      });
      return () => sub.subscription.unsubscribe();
    },

    async signIn(id, password) {
      const email = await authEmailFor(id);
      const { error } = await sb.auth.signInWithPassword({ email, password });
      return error ? { ok: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' } : { ok: true };
    },

    async signUp(id, password, nickname) {
      const loginId = id.trim();
      if (!loginId) return { ok: false, error: '아이디를 입력해 주세요.' };
      const email = await authEmailFor(loginId);
      const { error } = await sb.auth.signUp({
        email,
        password,
        options: { data: { nickname, login_id: loginId } },
      });
      if (!error) return { ok: true };
      if (/already registered|already exists/i.test(error.message)) {
        return { ok: false, error: '이미 사용 중인 아이디입니다.' };
      }
      return { ok: false, error: error.message };
    },

    async signOut() { await sb.auth.signOut(); },

    async resetPassword(email) {
      if (!email.includes('@')) {
        return { ok: false, error: '아이디 계정은 이메일 비밀번호 재설정을 사용할 수 없습니다.' };
      }
      const { error } = await sb.auth.resetPasswordForEmail(email);
      return error ? { ok: false, error: error.message } : { ok: true };
    },

    async updateProfile(patch) {
      const { data, error: userError } = await sb.auth.getUser();
      if (userError || !data.user) return { ok: false, error: '로그인이 필요합니다.' };

      // 비밀번호 변경은 profiles 테이블이 아니라 Supabase Auth에서 처리한다.
      // 현재 비밀번호를 먼저 다시 확인한 뒤 새 비밀번호로 갱신한다.
      if (patch.newPassword !== undefined) {
        if (!data.user.email) return { ok: false, error: '로그인 이메일을 확인할 수 없습니다.' };
        if (!patch.currentPassword) return { ok: false, error: '현재 비밀번호를 입력해 주세요.' };
        const { error: verifyError } = await sb.auth.signInWithPassword({
          email: data.user.email,
          password: patch.currentPassword,
        });
        if (verifyError) return { ok: false, error: '현재 비밀번호가 올바르지 않습니다.' };
        const { error: passwordError } = await sb.auth.updateUser({ password: patch.newPassword });
        if (passwordError) return { ok: false, error: passwordError.message };
      }

      // 가입 트리거가 이미 만든 내 profile 행만 UPDATE한다.
      // upsert는 INSERT RLS까지 검사해 기존 행 수정도 막히므로 사용하지 않는다.
      const row: Record<string, unknown> = {};
      if (patch.nickname !== undefined) row.nickname = patch.nickname;
      if (patch.avatarUrl !== undefined) row.avatar_url = patch.avatarUrl;
      if (patch.avatarColor !== undefined) row.avatar_color = patch.avatarColor;
      if (Object.keys(row).length === 0) return { ok: true };

      const { data: updated, error } = await sb.from('profiles')
        .update(row)
        .eq('id', data.user.id)
        .select('id')
        .maybeSingle();
      if (error) return { ok: false, error: error.message };
      if (!updated) return { ok: false, error: '프로필 정보를 찾을 수 없습니다. 다시 로그인해 주세요.' };
      return { ok: true };
    },

    // Supabase는 스키마의 트리거가 첫 가입자를 관리자로 만들어 준다 — 추가 작업 없음
    async claimOwner() { return { ok: true }; },

    async listMembers() {
      const { data, error } = await sb.from('profiles').select('id, nickname, role').order('created_at');
      if (error) throw error;
      return (data ?? []).map(r => {
        const p = r as { id: string; nickname: string; role: string };
        return { id: p.id, nickname: p.nickname, role: (p.role as 'admin' | 'member') ?? 'member' };
      });
    },

    async fetchList<T extends ListItem>(coll: string): Promise<T[]> {
      const { data, error } = await sb.from(coll).select('id, data, sort').order('sort', { ascending: true });
      if (error) throw error;
      return (data ?? []).map(r => {
        const row = r as { id: string; data: Record<string, unknown> };
        return { ...(row.data ?? {}), id: row.id } as T;
      });
    },

    async syncList<T extends ListItem>(coll: string, prev: T[], next: T[], uid: string | null) {
      const { inserts, updates, deletes } = diffList(prev, next);
      const toRow = ({ item, sort }: { item: T; sort: number }) => {
        const { authorId, visibility, editorIds } = metaOf(item, uid, visFloorOf(coll, item));
        return { id: item.id, data: item, author_id: authorId, visibility, editor_ids: editorIds, sort };
      };
      if (inserts.length) {
        const { error } = await sb.from(coll).insert(inserts.map(toRow));
        if (error) throw error;
      }
      if (updates.length) {
        const { error } = await sb.from(coll).upsert(updates.map(toRow), { onConflict: 'id' });
        if (error) throw error;
      }
      if (deletes.length) {
        const { error } = await sb.from(coll).delete().in('id', deletes);
        if (error) throw error;
      }
    },

    /* 공개범위만 다시 계산해 덮어쓰기 (v2.0) — 같은 값이 될 것들끼리 묶어 한 번에 UPDATE 한다.
       data를 다시 쓰지 않으므로 내용·순서가 흔들리지 않는다 */
    async refreshVis<T extends ListItem>(coll: string, items: T[], uid: string | null): Promise<number> {
      const byVis = new Map<string, string[]>();
      items.forEach(it => {
        const { visibility } = metaOf(it, uid, visFloorOf(coll, it));
        const arr = byVis.get(visibility) ?? [];
        arr.push(it.id);
        byVis.set(visibility, arr);
      });
      let n = 0;
      for (const [vis, ids] of byVis) {
        for (let i = 0; i < ids.length; i += 200) {
          const part = ids.slice(i, i + 200);
          const { error } = await sb.from(coll).update({ visibility: vis }).in('id', part);
          if (error) throw error;
          n += part.length;
        }
      }
      return n;
    },

    subscribe(coll, onChange) {
      const ch = sb.channel(`ohome:${coll}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: coll }, () => onChange())
        .subscribe();
      return () => { void sb.removeChannel(ch); };
    },

    async fetchSetting<T>(key: string) {
      const { data, error } = await sb.from('site_settings').select('value').eq('key', key).maybeSingle();
      if (error) throw error;
      return (data?.value ?? null) as T | null;
    },

    async saveSetting(key, value) {
      const { error } = await sb.from('site_settings')
        .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw error;
    },

    async fetchAllSettings() {
      const { data, error } = await sb.from('site_settings').select('key, value');
      if (error) throw error;
      const out: Record<string, unknown> = {};
      (data ?? []).forEach(r => { out[(r as { key: string }).key] = (r as { value: unknown }).value; });
      return out;
    },

    async uploadFile(blob, ext) {
      const path = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error } = await sb.storage.from(BUCKET)
        // 경로가 업로드마다 고유 — 기본 1시간 대신 길게 캐시 (firebaseBackend와 동일 정책)
        .upload(path, blob, {
          contentType: blob.type || 'application/octet-stream',
          cacheControl: '31536000',
          upsert: false,
        });
      if (error) throw error;
      return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
    },

    async listFiles() {
      const out: { ref: string; size: number }[] = [];
      const PAGE = 100;
      for (let offset = 0; ; offset += PAGE) {
        const { data, error } = await sb.storage.from(BUCKET).list('', { limit: PAGE, offset });
        if (error) throw error;
        const rows = data ?? [];
        rows.forEach(f => out.push({
          ref: sb.storage.from(BUCKET).getPublicUrl(f.name).data.publicUrl,
          size: (f.metadata as { size?: number } | null)?.size ?? 0,
        }));
        if (rows.length < PAGE) break;
      }
      return out;
    },

    async deleteFile(ref) {
      // 저장한 값은 공개 URL — 버킷 안 파일명만 떼어 지운다
      const name = decodeURIComponent(ref.split('?')[0].split('/').pop() ?? '');
      if (!name) return;
      const { error } = await sb.storage.from(BUCKET).remove([name]);
      if (error) throw error;
    },

    async deleteMember(id) {
      // profiles 행만 지운다 — auth.users 삭제는 service_role 키가 필요해 공개 홈에서는 불가
      const { error } = await sb.from('profiles').delete().eq('id', id);
      if (error) throw error;
    },
  };
}
