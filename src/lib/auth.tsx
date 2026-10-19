'use client';
// 인증 컨텍스트 (v2.0) — 백엔드 어댑터(Supabase / Firebase)에 위임한다.
// 백엔드 설정이 없으면(개발·오프라인) 브라우저 안의 로컬 계정으로 동작한다.
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { backend, isServerMode } from './backend';
import { setCurrentUserId } from './currentUser';
import { getSetting, setSetting } from './settingStore';

export type Role = 'admin' | 'member' | 'guest';

export interface User {
  id: string;
  nickname: string;
  role: Role;
  avatarUrl?: string;    // 프로필 이미지 (파일 참조 또는 URL)
  avatarColor?: string;  // 단색 아바타 (이미지 없을 때)
  email?: string;
}

type Result = { ok: boolean; error?: string };

interface AuthCtx {
  user: User | null;          // null = 비로그인
  isAdmin: boolean;
  login: (id: string, password: string) => Promise<Result>;
  signup: (id: string, password: string, nickname: string, inviteCode: string, email?: string) => Promise<Result>;
  findId: (email: string) => Promise<Result & { foundId?: string }>;
  resetPassword: (email: string) => Promise<Result & { tempPassword?: string }>;
  logout: () => Promise<void>;
  updateProfile: (patch: { nickname?: string; avatarUrl?: string | null; avatarColor?: string | null; currentPassword?: string; newPassword?: string }) => Promise<Result>;
  /** 서버(DB) 연결 없이 브라우저 계정으로 도는 중인지 — 개발·오프라인 */
  mock: boolean;
  /** 누가 보고 있는지 확인이 끝났는지 (v2.0) — 처음 한 박자는 늘 「비로그인」으로 보인다.
   *  그 사이에 권한을 판정하면 관리자에게도 「비공개」 화면이 번쩍인다. */
  ready: boolean;
}

const Ctx = createContext<AuthCtx | null>(null);
const MOCK_KEY = 'ohome.mockuser.v1';
// 탭 단위 인증 방문 기록. 다른 사이트로 떠난 뒤 돌아오면 재인증한다.
const VISIT_KEY = 'ohome.auth.visit.v1';
const EXIT_KEY = 'ohome.auth.exited.v1';

const MOCK_REG_KEY = 'ohome.mockreg.v1';
const INVITE_KEY = 'ohome.invite.v1';    // 가입코드 — 환경설정 > 회원/보안
const SETUP_KEY = 'ohome.setup.v1';      // 설치 화면을 마쳤는지

/** 현재 가입코드 — 관리자가 정한 값(서버 공유), 없으면 기본 WELCOME */
export function inviteCode(): string {
  return getSetting<string>(INVITE_KEY, 'WELCOME') || 'WELCOME';
}
export function setInviteCode(code: string) {
  setSetting(INVITE_KEY, code.trim());
}

export function isSetupDone(): boolean {
  try { return !!localStorage.getItem(SETUP_KEY); } catch { return false; }
}
export function markSetupDone() {
  try { localStorage.setItem(SETUP_KEY, JSON.stringify({ done: true, at: new Date().toISOString() })); } catch { /* 무시 */ }
}

/* ---------- 로컬 계정 (백엔드 없이 개발할 때) ---------- */

const MOCK_ACCOUNTS: Record<string, { password: string; user: User }> = {
  admin: { password: '0000', user: { id: 'admin', nickname: '관리자', role: 'admin' } },
  guest: { password: '0000', user: { id: 'guest', nickname: '지인회원', role: 'member' } },
};

function mockRegistry(): Record<string, { password: string; user: User }> {
  try { return JSON.parse(localStorage.getItem(MOCK_REG_KEY) ?? '{}'); } catch { return {}; }
}

/** 회원 프로필 조회 (관리자 회원 상세) — 로컬 모드에서만 의미가 있다 */
export function mockMemberInfo(id: string): User | null {
  const hit = mockRegistry()[id]?.user ?? (isSetupDone() ? undefined : MOCK_ACCOUNTS[id]?.user);
  return hit ? { ...hit } : null;
}

export interface SetupInput {
  adminId: string; adminPw: string; adminNick?: string;
  guestPw?: string;
}

/** 로컬 계정 설치 (백엔드 없이 쓸 때) */
export function completeSetup(v: SetupInput): { ok: boolean; error?: string } {
  const id = v.adminId.trim();
  if (!id || !v.adminPw) return { ok: false, error: '관리자 아이디와 비밀번호를 입력해 주세요.' };
  try {
    const reg = mockRegistry();
    reg[id] = { password: v.adminPw, user: { id, nickname: v.adminNick?.trim() || '관리자', role: 'admin' } };
    if (v.guestPw?.trim()) {
      reg.guest = { password: v.guestPw.trim(), user: { id: 'guest', nickname: '게스트', role: 'member' } };
    }
    localStorage.setItem(MOCK_REG_KEY, JSON.stringify(reg));
    markSetupDone();
    return { ok: true };
  } catch { return { ok: false, error: '설정을 저장하지 못했습니다.' }; }
}

/* ---------- 컨텍스트 ---------- */

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const server = isServerMode();
  const be = backend();
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);   // 확인이 끝났는지 (v2.0)

  useEffect(() => {
    let alive = true;
    // pagehide는 사이트 내부의 Next.js 메뉴 이동에는 발생하지 않는다.
    // 새로고침에도 발생하므로, 다음 진입이 reload이면 기존 인증을 유지한다.
    const onLeave = () => {
      try { sessionStorage.setItem(EXIT_KEY, '1'); } catch { /* 무시 */ }
    };
    window.addEventListener('pagehide', onLeave);

    const onReturn = (event: PageTransitionEvent) => {
      // 뒤로 가기로 BFCache의 기존 페이지가 복원되는 경우에는 React가 다시 mount되지 않는다.
      if (!event.persisted) return;
      let exited = false;
      try { exited = sessionStorage.getItem(EXIT_KEY) === '1'; } catch { /* 무시 */ }
      if (!exited) return;
      try {
        sessionStorage.removeItem(VISIT_KEY);
        sessionStorage.removeItem(EXIT_KEY);
      } catch { /* 무시 */ }
      setUser(null);
      setReady(false);
      if (server && be) {
        void be.signOut().catch(() => {}).finally(() => {
          if (alive) setReady(true);
        });
      } else {
        try { localStorage.removeItem(MOCK_KEY); } catch { /* 무시 */ }
        setReady(true);
      }
    };
    window.addEventListener('pageshow', onReturn);

    const initialize = async () => {
      const isReload = performance.getEntriesByType('navigation').some(
        entry => (entry as PerformanceNavigationTiming).type === 'reload',
      );
      let canResume = false;
      try {
        const visited = sessionStorage.getItem(VISIT_KEY) === '1';
        const exited = sessionStorage.getItem(EXIT_KEY) === '1';
        canResume = visited && (!exited || isReload);
        sessionStorage.removeItem(EXIT_KEY);
        if (!canResume) sessionStorage.removeItem(VISIT_KEY);
      } catch { /* 저장소 차단 시 안전하게 재로그인 */ }

      if (!server || !be) {
        if (canResume) {
          try {
            const raw = localStorage.getItem(MOCK_KEY);
            if (raw && alive) setUser(JSON.parse(raw));
          } catch { /* 무시 */ }
        } else {
          try { localStorage.removeItem(MOCK_KEY); } catch { /* 무시 */ }
        }
        if (alive) setReady(true);
        return;
      }
      if (!canResume) {
        // 서버 세션도 실제로 종료해야 다음 방문에서 자동 로그인되지 않는다.
        try { await be.signOut(); } catch { /* 네트워크 실패 시에도 UI는 비로그인 */ }
        if (alive) { setUser(null); setReady(true); }
      } else {
        try {
          const u = await be.currentUser();
          if (alive) { setUser(u as User | null); setReady(true); }
        } catch {
          if (alive) setReady(true);
        }
      }
      if (!alive) return;
      off = be.onAuthChange(u => {
        if (alive) { setUser(u as User | null); setReady(true); }
      });
    };
    let off: (() => void) | undefined;
    void initialize();
    return () => {
      alive = false;
      off?.();
      window.removeEventListener('pagehide', onLeave);
      window.removeEventListener('pageshow', onReturn);
    };
  }, [server, be]);

  const login = useCallback(async (id: string, password: string): Promise<Result> => {
    if (server && be) {
      const r = await be.signIn(id.trim(), password);
      if (r.ok) { try { sessionStorage.setItem(VISIT_KEY, '1'); sessionStorage.removeItem(EXIT_KEY); } catch { /* 무시 */ } }
      return r.ok ? { ok: true } : { ok: false, error: r.error ?? '로그인에 실패했습니다.' };
    }
    const acc = mockRegistry()[id] ?? (isSetupDone() ? undefined : MOCK_ACCOUNTS[id]);
    if (!acc || acc.password !== password) return { ok: false, error: '아이디 또는 비밀번호가 올바르지 않습니다.' };
    setUser(acc.user);
    try { sessionStorage.setItem(VISIT_KEY, '1'); sessionStorage.removeItem(EXIT_KEY); } catch { /* 무시 */ }
    try { localStorage.setItem(MOCK_KEY, JSON.stringify(acc.user)); } catch { /* 무시 */ }
    return { ok: true };
  }, [server, be]);

  // 회원가입 — 가입코드(초대코드) 방식
  const signup = useCallback(async (id: string, password: string, nickname: string, code: string): Promise<Result> => {
    if (!id || !password || !nickname) return { ok: false, error: '아이디·비밀번호·닉네임을 모두 입력해 주세요.' };
    if (code !== inviteCode()) return { ok: false, error: '가입코드가 올바르지 않습니다.' };
    if (server && be) {
      const r = await be.signUp(id.trim(), password, nickname.trim());
      if (!r.ok) return { ok: false, error: r.error ?? '가입에 실패했습니다.' };
      try { sessionStorage.setItem(VISIT_KEY, '1'); sessionStorage.removeItem(EXIT_KEY); } catch { /* 무시 */ }
      // 계정이 만들어지는 순간 로그인 상태가 되며 사용자 정보가 먼저 계산되는데,
      // 그때는 닉네임(프로필)이 아직 저장되기 전이라 이메일이 이름 자리에 들어간다.
      // 저장이 끝난 지금 다시 읽어 이름을 바로잡는다.
      try { const u = await be.currentUser(); if (u) setUser(u); } catch { /* 무시 */ }
      return { ok: true };
    }
    if (MOCK_ACCOUNTS[id] || mockRegistry()[id]) return { ok: false, error: '이미 사용 중인 아이디입니다.' };
    const reg = mockRegistry();
    reg[id] = { password, user: { id, nickname, role: 'member' } };
    try { localStorage.setItem(MOCK_REG_KEY, JSON.stringify(reg)); } catch { /* 무시 */ }
    return { ok: true };
  }, [server, be]);

  const findId = useCallback(async (email: string): Promise<Result & { foundId?: string }> => {
    if (!email.trim()) return { ok: false, error: '이메일을 입력해 주세요.' };
    if (server) return { ok: false, error: '이메일이 곧 아이디입니다 — 그대로 로그인해 주세요.' };
    const hit = Object.values(mockRegistry()).find(a => a.user.email?.toLowerCase() === email.trim().toLowerCase());
    return hit ? { ok: true, foundId: hit.user.id } : { ok: false, error: '이 이메일로 가입된 계정이 없습니다.' };
  }, [server]);

  const resetPassword = useCallback(async (email: string): Promise<Result & { tempPassword?: string }> => {
    if (!email.trim()) return { ok: false, error: '이메일을 입력해 주세요.' };
    if (server && be) {
      const r = await be.resetPassword(email.trim());
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    const reg = mockRegistry();
    const hit = Object.entries(reg).find(([, a]) => a.user.email?.toLowerCase() === email.trim().toLowerCase());
    if (!hit) return { ok: false, error: '이 이메일로 가입된 계정이 없습니다.' };
    const temp = Math.random().toString(36).slice(2, 8);
    reg[hit[0]] = { ...hit[1], password: temp };
    try { localStorage.setItem(MOCK_REG_KEY, JSON.stringify(reg)); } catch { /* 무시 */ }
    return { ok: true, tempPassword: temp };
  }, [server, be]);

  const updateProfile = useCallback(async (patch: {
    nickname?: string; avatarUrl?: string | null; avatarColor?: string | null; currentPassword?: string; newPassword?: string;
  }): Promise<Result> => {
    if (!user) return { ok: false, error: '로그인이 필요합니다.' };
    if (server && be) {
      const r = await be.updateProfile(patch);
      if (!r.ok) return r;
      setUser(u => (u ? {
        ...u,
        nickname: patch.nickname?.trim() || u.nickname,
        avatarUrl: patch.avatarUrl === null ? undefined : (patch.avatarUrl ?? u.avatarUrl),
        avatarColor: patch.avatarColor === null ? undefined : (patch.avatarColor ?? u.avatarColor),
      } : u));
      return { ok: true };
    }
    const reg = mockRegistry();
    const cur = reg[user.id] ?? (isSetupDone() ? undefined : MOCK_ACCOUNTS[user.id]);
    if (!cur) return { ok: false, error: '계정을 찾을 수 없습니다.' };
    if (patch.newPassword && patch.currentPassword !== cur.password) {
      return { ok: false, error: '현재 비밀번호가 올바르지 않습니다.' };
    }
    const nextUser: User = {
      ...cur.user,
      nickname: patch.nickname?.trim() || cur.user.nickname,
      avatarUrl: patch.avatarUrl === null ? undefined : (patch.avatarUrl ?? cur.user.avatarUrl),
      avatarColor: patch.avatarColor === null ? undefined : (patch.avatarColor ?? cur.user.avatarColor),
    };
    reg[user.id] = { password: patch.newPassword || cur.password, user: nextUser };
    try {
      localStorage.setItem(MOCK_REG_KEY, JSON.stringify(reg));
      localStorage.setItem(MOCK_KEY, JSON.stringify(nextUser));
    } catch { /* 무시 */ }
    setUser(nextUser);
    return { ok: true };
  }, [server, be, user]);

  const logout = useCallback(async () => {
    try { sessionStorage.removeItem(VISIT_KEY); sessionStorage.removeItem(EXIT_KEY); } catch { /* 무시 */ }
    if (server && be) { await be.signOut(); setUser(null); return; }
    setUser(null);
    try { localStorage.removeItem(MOCK_KEY); } catch { /* 무시 */ }
  }, [server, be]);

  // 관리자면 body.admin — 페이지 설명 편집 연필 등
  // 저장 계층이 훅 밖에서 작성자 id를 알 수 있게 함께 기록
  useEffect(() => {
    document.body.classList.toggle('admin', user?.role === 'admin');
    setCurrentUserId(user?.id ?? null);
  }, [user]);

  return (
    <Ctx.Provider value={{
      user, isAdmin: user?.role === 'admin', ready,
      login, signup, findId, resetPassword, logout, updateProfile, mock: !server,
    }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
