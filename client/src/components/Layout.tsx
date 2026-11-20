import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useAppConfig } from '../hooks/useAppConfig';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { timeAgo } from '../lib/format';
import { Link, useRouter } from '../lib/router';
import type { AppNotification } from '../types';

export function Logo() {
  return (
    <span className="logo" aria-label="Subly AI">
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="url(#lg)" />
        <rect x="6" y="19" width="20" height="3.5" rx="1.75" fill="#fff" />
        <rect x="9" y="12" width="14" height="3.5" rx="1.75" fill="#fff" opacity=".7" />
        <defs>
          <linearGradient id="lg" x1="0" y1="0" x2="32" y2="32">
            <stop stopColor="#8b6cff" />
            <stop offset="1" stopColor="#4f7cff" />
          </linearGradient>
        </defs>
      </svg>
      <span>
        Subly<span className="logo-ai"> AI</span>
      </span>
    </span>
  );
}

/** Closes a dropdown when the user clicks elsewhere or presses Escape. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

function NotificationBell() {
  const { unread, refresh } = useAuth();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const ref = useDismiss(open, () => setOpen(false));

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    try {
      const data = await api.notifications();
      setItems(data.items);
      if (data.unread > 0) {
        await api.markNotificationsRead();
        await refresh();
      }
    } catch {
      setItems([]);
    }
  }

  return (
    <div className="dropdown" ref={ref}>
      <button type="button" className="icon-pill" onClick={() => void toggle()} aria-haspopup="true" aria-expanded={open} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>
        {unread > 0 && <span className="badge-dot" data-testid="unread-count">{unread}</span>}
      </button>
      {open && (
        <div className="dropdown-panel notifications" role="menu">
          <strong className="dropdown-title">Notifications</strong>
          {items === null ? <p className="muted small">Loading…</p> : items.length === 0 ? <p className="muted small">Nothing yet.</p> : (
            <ul>
              {items.map((n) => (
                <li key={n.id} className={n.kind.startsWith('credits') ? 'is-warn' : ''}>
                  <strong>{n.title}</strong>
                  <span>{n.body}</span>
                  <span className="muted small">{timeAgo(n.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, signOut } = useAuth();
  const { navigate } = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  if (!user) return null;
  return (
    <div className="dropdown" ref={ref}>
      <button type="button" className="avatar" onClick={() => setOpen(!open)} aria-haspopup="true" aria-expanded={open} aria-label="Account menu">
        {(user.name || user.email).charAt(0).toUpperCase()}
      </button>
      {open && (
        <div className="dropdown-panel" role="menu">
          <div className="dropdown-title"><strong>{user.name}</strong><span className="muted small">{user.email}</span></div>
          <Link to="/billing" className="menu-item">Credits &amp; billing</Link>
          <button type="button" className="menu-item" onClick={() => void signOut().then(() => navigate('/login'))}>Sign out</button>
        </div>
      )}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { path } = useRouter();
  const { user, credits } = useAuth();
  const { config } = useAppConfig();
  const low = !!credits && !!config && credits.total <= config.credits.lowThreshold;
  const active = path === '/' || path.startsWith('/new') ? 'home' : path.startsWith('/billing') ? 'billing' : '';
  const current = (name: string) => (active === name ? ('page' as const) : undefined);
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="site-header">
        <div className="container header-inner">
          <Link to="/" className="brand" aria-label="Subly AI home">
            <Logo />
          </Link>
          {user && (
            <nav aria-label="Main navigation" className="main-nav">
              <Link to="/" aria-current={current('home')}>Projects</Link>
              <Link to="/billing" aria-current={current('billing')}>Credits &amp; billing</Link>
            </nav>
          )}
          <div className="header-actions">
            {user && credits && (
              <Link to="/billing" className={`credit-pill${low ? ' is-low' : ''}`} aria-label={`${credits.total} credits${low ? ', running low' : ''}`}>
                <span aria-hidden="true">✦</span> <span data-testid="credit-total">{credits.total}</span> credits
              </Link>
            )}
            {user && <NotificationBell />}
            <UserMenu />
            {user === null && <Link to="/login" className="btn btn-sm">Sign in</Link>}
          </div>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="site-footer">
        <div className="container footer-inner">
          <span>&copy; 2026 Subly AI</span>
          <span className="muted">Videos are stored on the server you run Subly AI on and are only visible to your account.</span>
        </div>
      </footer>
    </>
  );
}
