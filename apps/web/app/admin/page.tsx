'use client';
import { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, Users, Flag, ScrollText, Check, Ban, Trash2 } from 'lucide-react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/features/auth/store';
import { Button } from '@/components/ui/button';
import { ToastProvider, useToast } from '@/components/ui/toast';
import { Skeleton, EmptyState } from '@/components/ui/bits';
import { cn } from '@/lib/cn';

interface Stats {
  users: number; active_24h: number; new_7d: number; messages: number;
  snaps: number; live_stories: number; open_reports: number;
  suspended: number; banned: number; storage_bytes: number;
}
interface Report {
  id: string; target_type: string; target_id: string; reason: string;
  detail: string | null; created_at: string;
  reporter_username: string | null; target_username: string | null; total_reports: number;
}
interface AdminUser {
  id: string; username: string; email: string | null; status: string;
  display_name: string; friend_count: number; reports_against: number; last_seen_at: string | null;
}
interface AuditRow {
  id: number; action: string; entity: string | null; entity_id: string | null;
  created_at: string; admin_username: string | null;
}

/**
 * Admin dashboard (spec §30).
 *
 * A separate route rather than a tab in the app: moderators are a different
 * audience with a different job, and mixing the two invites accidental
 * moderation from a phone.
 *
 * The API answers 404 to non-admins, so this page cannot enumerate anything by
 * existing — it simply shows nothing to anyone who is not one.
 */
export default function AdminPage() {
  return <ToastProvider><Admin /></ToastProvider>;
}

function Admin() {
  const { user, status, restore } = useAuth();
  const [tab, setTab] = useState<'reports' | 'users' | 'audit'>('reports');
  const [stats, setStats] = useState<Stats | null>(null);
  const [denied, setDenied] = useState(false);

  useEffect(() => { void restore(); }, [restore]);

  const loadStats = useCallback(async () => {
    try { setStats(await api<Stats>('/admin/stats')); }
    catch (e) { if (e instanceof ApiError && e.status === 404) setDenied(true); }
  }, []);

  useEffect(() => { if (status === 'authed') void loadStats(); }, [status, loadStats]);

  if (status === 'loading') {
    return <div className="grid min-h-dvh place-items-center">
      <div className="h-12 w-12 animate-pulse rounded-2xl bg-surface-2" /></div>;
  }

  if (status === 'anon' || denied) {
    return (
      <div className="grid min-h-dvh place-items-center px-8 text-center">
        <div className="space-y-3">
          <ShieldAlert size={32} className="mx-auto text-ink-faint" />
          <h1 className="text-lg font-semibold">Not found</h1>
          <p className="max-w-xs text-sm text-ink-dim">
            This page does not exist for your account.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto min-h-dvh max-w-5xl px-5 py-8">
      <header className="mb-8 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">SNAPX admin</h1>
          <p className="text-sm text-ink-dim">Signed in as @{user?.username}</p>
        </div>
        {stats && stats.open_reports > 0 && (
          <span className="rounded-full bg-danger px-3 py-1 text-xs font-semibold text-white">
            {stats.open_reports} open
          </span>
        )}
      </header>

      {stats ? (
        <div className="mb-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Users" value={stats.users} sub={`${stats.new_7d} new this week`} />
          <Stat label="Active today" value={stats.active_24h} />
          <Stat label="Messages" value={stats.messages} />
          <Stat label="Snaps" value={stats.snaps} />
          <Stat label="Live stories" value={stats.live_stories} />
          <Stat label="Open reports" value={stats.open_reports} tone={stats.open_reports ? 'danger' : undefined} />
          <Stat label="Suspended" value={stats.suspended} />
          <Stat label="Storage" value={`${(stats.storage_bytes / 1048576).toFixed(1)} MB`} />
        </div>
      ) : <Skeleton rows={2} />}

      <nav className="mb-5 flex gap-1 border-b border-line">
        {([['reports', 'Reports', Flag], ['users', 'Users', Users], ['audit', 'Audit log', ScrollText]] as const)
          .map(([id, label, Icon]) => (
            <button key={id} onClick={() => setTab(id)}
              className={cn('flex items-center gap-2 px-4 py-2.5 text-sm transition',
                tab === id ? 'border-b-2 border-brand font-semibold text-ink' : 'text-ink-dim')}>
              <Icon size={15} /> {label}
            </button>
          ))}
      </nav>

      {tab === 'reports' && <Reports onChange={loadStats} />}
      {tab === 'users' && <UsersTab />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

const Stat = ({ label, value, sub, tone }: {
  label: string; value: number | string; sub?: string; tone?: 'danger';
}) => (
  <div className="rounded-xl border border-line bg-surface p-4">
    <p className="text-xs uppercase tracking-wider text-ink-faint">{label}</p>
    <p className={cn('mt-1 text-2xl font-bold tabular-nums', tone === 'danger' && 'text-danger')}>
      {value}
    </p>
    {sub && <p className="mt-0.5 text-[11px] text-ink-dim">{sub}</p>}
  </div>
);

function Reports({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<Report[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRows(await api<Report[]>('/admin/reports').catch(() => []));
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act = async (id: string, action: string) => {
    // Destructive moderation gets a confirm step. A misclick that bans someone
    // is a different kind of mistake to a misclick that dismisses a report.
    if ((action === 'ban' || action === 'suspend')
      && !confirm(`${action === 'ban' ? 'Ban' : 'Suspend'} this account? Their sessions end immediately.`)) return;
    setBusy(id);
    try {
      await api(`/admin/reports/${id}/act`, { method: 'POST', body: { action } });
      toast(`Report ${action === 'dismiss' ? 'dismissed' : 'actioned'}`);
      await load(); onChange();
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'That did not work', 'error');
    } finally { setBusy(null); }
  };

  if (!rows) return <Skeleton rows={3} />;
  if (!rows.length) return <EmptyState title="Queue is empty" body="No open reports. " />;

  return (
    <div className="space-y-3">
      {rows.map(r => (
        <div key={r.id} className="rounded-xl border border-line bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-danger/15 px-2.5 py-0.5 text-xs font-medium text-danger">
              {r.reason}
            </span>
            <span className="text-xs text-ink-dim">{r.target_type}</span>
            {r.target_username && <span className="text-sm font-medium">@{r.target_username}</span>}
            {r.total_reports > 1 && (
              <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[11px] text-warn">
                {r.total_reports} reports
              </span>
            )}
            <span className="ml-auto text-[11px] text-ink-faint">
              by @{r.reporter_username ?? 'deleted'}
            </span>
          </div>
          {r.detail && <p className="mt-2 text-sm text-ink-dim">{r.detail}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" loading={busy === r.id}
              onClick={() => act(r.id, 'dismiss')}><Check size={14} /> Dismiss</Button>
            <Button size="sm" variant="secondary"
              onClick={() => act(r.id, 'warn')}>Warn</Button>
            {r.target_type !== 'user' && (
              <Button size="sm" variant="secondary"
                onClick={() => act(r.id, 'remove_content')}><Trash2 size={14} /> Remove</Button>
            )}
            {r.target_type === 'user' && <>
              <Button size="sm" variant="secondary"
                onClick={() => act(r.id, 'suspend')}>Suspend 7d</Button>
              <Button size="sm" variant="danger"
                onClick={() => act(r.id, 'ban')}><Ban size={14} /> Ban</Button>
            </>}
          </div>
        </div>
      ))}
    </div>
  );
}

function UsersTab() {
  const [rows, setRows] = useState<AdminUser[] | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    const t = setTimeout(async () => {
      setRows(await api<AdminUser[]>(`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`)
        .catch(() => []));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div>
      <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search users"
        aria-label="Search users"
        className="mb-4 h-11 w-full rounded-xl border border-line bg-surface px-4 text-sm
                   placeholder:text-ink-faint focus:border-brand focus:outline-none" />
      {!rows ? <Skeleton rows={4} /> : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs uppercase tracking-wider text-ink-faint">
              <tr>
                <th className="px-4 py-3">User</th><th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Friends</th>
                <th className="px-4 py-3 text-right">Reports</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(u => (
                <tr key={u.id} className="border-t border-line">
                  <td className="px-4 py-3">
                    <p className="font-medium">{u.display_name}</p>
                    <p className="text-xs text-ink-dim">@{u.username}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('rounded-full px-2 py-0.5 text-xs',
                      u.status === 'active' ? 'bg-ok/15 text-ok'
                        : u.status === 'banned' ? 'bg-danger/15 text-danger'
                        : 'bg-warn/15 text-warn')}>{u.status}</span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{u.friend_count}</td>
                  <td className={cn('px-4 py-3 text-right tabular-nums',
                    u.reports_against > 0 && 'font-semibold text-danger')}>{u.reports_against}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Audit() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  useEffect(() => { void api<AuditRow[]>('/admin/audit').then(setRows).catch(() => setRows([])); }, []);

  if (!rows) return <Skeleton rows={4} />;
  if (!rows.length) return <EmptyState title="Nothing logged yet" body="Moderation actions appear here." />;

  return (
    <div className="space-y-1">
      <p className="pb-3 text-xs text-ink-faint">
        Append-only. Rows cannot be edited or deleted, enforced by a database trigger.
      </p>
      {rows.map(r => (
        <div key={r.id} className="flex items-center gap-3 border-b border-line px-1 py-2.5 text-sm">
          <span className="rounded bg-surface-2 px-2 py-0.5 font-mono text-xs">{r.action}</span>
          <span className="text-ink-dim">{r.entity}</span>
          <span className="ml-auto text-xs text-ink-faint">
            @{r.admin_username ?? 'system'} · {new Date(r.created_at).toLocaleString()}
          </span>
        </div>
      ))}
    </div>
  );
}
