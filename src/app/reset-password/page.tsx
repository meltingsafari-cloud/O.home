'use client';
// 비밀번호 복구 링크에 포함된 인증 정보만으로 변경 화면을 연다.
// 기존 로그인 세션만으로는 비밀번호 변경 화면을 열지 않는다.
import React, { useEffect, useState } from 'react';
import { loadServerConfig } from '@/lib/serverConfig';
import { KInput } from '@/components/ui/Kit';
import type { SupabaseClient } from '@supabase/supabase-js';

export default function ResetPasswordPage() {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'invalid' | 'done'>('loading');
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const boot = async () => {
      try {
        const search = new URLSearchParams(window.location.search);
        const fragment = new URLSearchParams(window.location.hash.slice(1));
        const code = search.get('code');
        const tokenHash = search.get('token_hash');
        const type = search.get('type') ?? fragment.get('type');
        const accessToken = fragment.get('access_token');
        const refreshToken = fragment.get('refresh_token');

        // 링크를 통한 복구만 허용. 이미 로그인한 사용자의 일반 세션은 허용하지 않음.
        const isPkce = Boolean(code);
        const isOtp = Boolean(tokenHash && type === 'recovery');
        const isImplicit = type === 'recovery' && Boolean(accessToken && refreshToken);
        if (!isPkce && !isOtp && !isImplicit) throw new Error('재설정 인증 정보가 없습니다. 새 링크를 요청해 주세요.');

        const cfg = await loadServerConfig();
        if (!cfg || cfg.kind !== 'supabase') throw new Error('Supabase 연결 설정을 찾지 못했습니다.');
        const { createBrowserClient } = await import('@supabase/ssr');
        // Supabase가 URL의 code를 자동 교환하기 전에 명시적으로 처리한다.
        // createBrowserClient를 사용해야 메일 요청 때 저장한 PKCE verifier 저장소와 일치한다.
        const sb = createBrowserClient(cfg.url.replace(/\/$/, ''), cfg.anonKey, {
          auth: { detectSessionInUrl: false },
        });

        if (isOtp) {
          const { error: verifyError } = await sb.auth.verifyOtp({ token_hash: tokenHash!, type: 'recovery' });
          if (verifyError) throw verifyError;
        } else if (isPkce) {
          // 기존 로그인 세션이 있어도 반드시 복구 code를 교환한다.
          const { error: exchangeError } = await sb.auth.exchangeCodeForSession(code!);
          if (exchangeError) throw exchangeError;
        } else {
          const { error: setError } = await sb.auth.setSession({
            access_token: accessToken!, refresh_token: refreshToken!,
          });
          if (setError) throw setError;
        }

        const { data: userData, error: userError } = await sb.auth.getUser();
        if (userError || !userData.user) throw new Error('복구 인증이 만료되었거나 유효하지 않습니다.');
        if (!active) return;
        setClient(sb);
        setStatus('ready');
        // 인증 코드가 주소창, 브라우저 기록 등에 남지 않게 제거한다.
        window.history.replaceState(window.history.state, '', '/reset-password');
      } catch (e) {
        if (active) {
          setError(e instanceof Error ? e.message : '복구 링크를 확인하지 못했습니다.');
          setStatus('invalid');
        }
      }
    };
    void boot();
    return () => { active = false; };
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
