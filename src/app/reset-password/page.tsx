'use client';
// Supabase 비밀번호 복구 링크 전용 페이지. 일반 로그인 세션만으로 변경 폼을 열지 않는다.
import React, { useEffect, useState } from 'react';
import { loadServerConfig } from '@/lib/serverConfig';
import { KInput } from '@/components/ui/Kit';

export default function ResetPasswordPage() {
  const [client, setClient] = useState<import('@supabase/supabase-js').SupabaseClient | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'invalid' | 'done'>('loading');
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    const boot = async () => {
      try {
        const cfg = await loadServerConfig();
        if (!cfg || cfg.kind !== 'supabase') throw new Error('Supabase 연결 설정을 찾지 못했습니다.');
        const { createBrowserClient } = await import('@supabase/ssr');
        const sb = createBrowserClient(cfg.url.replace(/\/$/, ''), cfg.anonKey);
        const params = new URLSearchParams(window.location.search);
        const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        const recoveryLink = params.has('code') || params.has('token_hash') || hash.get('type') === 'recovery';
        if (!recoveryLink) {
          if (alive) setStatus('invalid');
          return;
        }
        const { data: listener } = sb.auth.onAuthStateChange((event) => {
          if (event === 'PASSWORD_RECOVERY' && alive) setStatus('ready');
        });
        unsubscribe = () => listener.subscription.unsubscribe();
        if (params.has('token_hash')) {
          const { error: verifyError } = await sb.auth.verifyOtp({
            token_hash: params.get('token_hash')!, type: 'recovery',
          });
          if (verifyError) throw verifyError;
        } else if (params.has('code')) {
          // PKCE 코드: 이미 앱 부팅 과정에서 교환되었을 수도 있다.
          const { data: existing } = await sb.auth.getSession();
          if (!existing.session) {
            const { error: exchangeError } = await sb.auth.exchangeCodeForSession(params.get('code')!);
            if (exchangeError) throw exchangeError;
          }
        }
        const { data, error: sessionError } = await sb.auth.getSession();
        if (sessionError || !data.session) throw new Error('복구 인증이 만료되었거나 유효하지 않습니다.');
        if (alive) { setClient(sb); setStatus('ready'); }
        window.history.replaceState({}, '', '/reset-password');
      } catch (e) {
        if (alive) { setError(e instanceof Error ? e.message : '복구 링크를 확인하지 못했습니다.'); setStatus('invalid'); }
      }
    };
    void boot();
    return () => { alive = false; unsubscribe?.(); };
  }, []);

  const submit = async () => {
    if (!client || busy) return;
    setError('');
    if (password.length < 6) { setError('비밀번호는 6자 이상 입력해 주세요.'); return; }
    if (password !== confirm) { setError('비밀번호가 서로 일치하지 않습니다.'); return; }
    setBusy(true);
    try {
      const { error: updateError } = await client.auth.updateUser({ password });
      if (updateError) throw updateError;
      setPassword(''); setConfirm(''); setStatus('done');
    } catch (e) { setError(e instanceof Error ? e.message : '비밀번호 변경에 실패했습니다.'); }
    finally { setBusy(false); }
  };

  return (
    <section className="page">
      <div className="panel" style={{ padding: 28, maxWidth: 480, margin: '40px auto 0' }}>
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 24, textAlign: 'center', color: 'var(--ink)' }}>RESET PASSWORD</h1>
        {status === 'loading' && <p>재설정 링크를 확인하고 있습니다…</p>}
        {status === 'invalid' && <p>유효한 비밀번호 재설정 링크가 아닙니다. 로그인 화면에서 새 링크를 요청해 주세요.</p>}
        {status === 'ready' && (
          <div style={{ display: 'grid', gap: 10, marginTop: 18 }}>
            <p>새 비밀번호를 입력해 주세요.</p>
            <KInput type="password" placeholder="새 비밀번호 (6자 이상)" value={password} onChange={e => setPassword(e.target.value)} />
            <KInput type="password" placeholder="새 비밀번호 확인" value={confirm} onChange={e => setConfirm(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void submit(); }} />
            <button className="btn btn-dark" disabled={busy} onClick={() => void submit()}>{busy ? '변경 중…' : '비밀번호 변경'}</button>
          </div>
        )}
        {status === 'done' && <p>비밀번호가 변경되었습니다. 이제 새 비밀번호로 로그인할 수 있습니다.</p>}
        {error && <p role="alert" style={{ color: 'var(--accent)', marginTop: 12 }}>{error}</p>}
        <a className="btn btn-ghost" href="/login" style={{ display: 'inline-flex', marginTop: 18 }}>로그인 화면으로</a>
      </div>
    </section>
  );
}
