'use client';

// TEMPORARY SELF-SERVICE PAGE. Delete this route after recovering the account.
// Uses only the signed-in Supabase user's own session; never uses service_role.
import React, { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadServerConfig } from '@/lib/serverConfig';

export default function AccountRepairPage() {
  const [sb, setSb] = useState<SupabaseClient | null>(null);
  const [email, setEmail] = useState('');
  const [confirmEmail, setConfirmEmail] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'done' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const cfg = await loadServerConfig();
        if (!cfg || cfg.kind !== 'supabase') throw new Error('Supabase 연결 설정이 없습니다.');
        const { createBrowserClient } = await import('@supabase/ssr');
        const client = createBrowserClient(cfg.url.replace(/\/$/, ''), cfg.anonKey);
        const { data, error } = await client.auth.getUser();
        if (error || !data.user?.email) throw new Error('로그인 상태를 확인할 수 없습니다. 기존 창에서 로그아웃하지 마세요.');
        if (mounted) { setSb(client); setEmail(data.user.email); setState('ready'); }
      } catch (e) {
        if (mounted) { setMessage(e instanceof Error ? e.message : '인증 확인 실패'); setState('error'); }
      }
    })();
    return () => { mounted = false; };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!sb || busy) return;
    setMessage('');
    if (confirmEmail.trim().toLowerCase() !== email.toLowerCase()) { setMessage('계정 이메일 확인이 일치하지 않습니다.'); return; }
    if (pw.length < 12) { setMessage('새 비밀번호는 12자 이상으로 설정해 주세요.'); return; }
    if (pw !== pw2) { setMessage('새 비밀번호가 일치하지 않습니다.'); return; }
    setBusy(true);
    try {
      const { data, error: userError } = await sb.auth.getUser();
      if (userError || !data.user || data.user.email?.toLowerCase() !== email.toLowerCase()) {
        throw new Error('로그인 세션을 다시 확인할 수 없습니다.');
      }
      const { error } = await sb.auth.updateUser({ password: pw });
      if (error) throw error;
      setPw(''); setPw2(''); setConfirmEmail(''); setState('done');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '변경에 실패했습니다.');
    } finally { setBusy(false); }
  };

  return (
    <main style={{ maxWidth: 520, margin: '60px auto', padding: 28, background: '#fff', color: '#222', borderRadius: 14 }}>
      <h1 style={{ fontSize: 26, marginBottom: 16 }}>임시 계정 복구</h1>
      <p>현재 로그인된 <strong>본인 계정</strong>의 비밀번호만 변경합니다. 복구 후 이 페이지를 반드시 삭제하세요.</p>
      {state === 'loading' && <p>로그인 상태 확인 중…</p>}
      {state === 'error' && <p role="alert">{message}</p>}
      {state === 'done' && <p role="status">비밀번호 변경 요청이 성공했습니다. 이 페이지를 삭제한 뒤, 별도 브라우저에서 새 비밀번호로 로그인을 확인하세요.</p>}
      {state === 'ready' && (
        <form onSubmit={submit} style={{ display: 'grid', gap: 14, marginTop: 20 }}>
          <p>현재 계정: <strong>{email}</strong></p>
          <label>계정 이메일을 다시 입력해 확인
            <input required type="email" autoComplete="off" value={confirmEmail} onChange={e => setConfirmEmail(e.target.value)} style={{ display: 'block', width: '100%', padding: 10 }} />
          </label>
          <label>새 비밀번호 (12자 이상)
            <input required type="password" minLength={12} autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} style={{ display: 'block', width: '100%', padding: 10 }} />
          </label>
          <label>새 비밀번호 확인
            <input required type="password" minLength={12} autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)} style={{ display: 'block', width: '100%', padding: 10 }} />
          </label>
          <button type="submit" disabled={busy} style={{ padding: 12, cursor: 'pointer' }}>{busy ? '변경 중…' : '내 계정 비밀번호 변경'}</button>
          {message && <p role="alert" style={{ color: '#a22' }}>{message}</p>}
        </form>
      )}
    </main>
  );
}
