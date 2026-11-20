import { useCallback, useEffect, useState } from 'react';
import { Alert, Spinner } from '../components/ui';
import { api, describeError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatMoney } from '../lib/money';
import type { BillingInfo, CatalogItem, LedgerEntry, Payment } from '../types';

const KIND_LABEL: Record<string, string> = {
  free_grant: 'Free monthly credits', free_expire: 'Free credits expired', spend: 'Used', refund: 'Refund', purchase: 'Purchase', subscription: 'Subscription', adjust: 'Adjustment',
};
const date = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function BillingPage() {
  const { refresh } = useAuth();
  const [info, setInfo] = useState<BillingInfo | null>(null);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [moreLedger, setMoreLedger] = useState(true);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ kind: 'success' | 'info'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [b, l, p] = await Promise.all([api.billing(), api.ledger(), api.payments()]);
      setInfo(b);
      setLedger(l.entries);
      setMoreLedger(l.entries.length >= 50);
      setPayments(p.payments);
      void refresh();
    } catch (e) {
      setError(describeError(e));
    }
  }, [refresh]);

  useEffect(() => {
    void load();
    // Coming back from the payment page: the confirmation can arrive a few seconds later (webhook).
    const status = new URLSearchParams(window.location.search).get('checkout');
    if (status === 'success') {
      setMessage({ kind: 'success', text: 'Thank you! Your payment is being confirmed. Your credits appear here as soon as the payment provider confirms it (usually within seconds).' });
      const timers = [3000, 8000, 15000].map((ms) => setTimeout(() => void load(), ms));
      return () => timers.forEach(clearTimeout);
    }
    if (status === 'demo-paid') setMessage({ kind: 'success', text: 'Demo payment complete: the credits were added to your account (no real money was charged).' });
    if (status === 'canceled') setMessage({ kind: 'info', text: 'Checkout was canceled. You have not been charged.' });
    return undefined;
  }, [load]);

  async function buy(item: CatalogItem) {
    setBusy(item.id);
    setError(null);
    try {
      const { url } = await api.checkout(item.id);
      window.location.assign(url); // Stripe's page, or our demo checkout page
    } catch (e) {
      setError(describeError(e));
      setBusy(null);
    }
  }

  async function portal() {
    setBusy('portal');
    try {
      const { url } = await api.portal();
      window.location.assign(url);
    } catch (e) {
      setError(describeError(e));
      setBusy(null);
    }
  }

  async function cancelDemo() {
    setBusy('cancel');
    try {
      await api.demoCancelSubscription();
      await load();
      setMessage({ kind: 'info', text: 'Demo subscription ended. Credits you already have stay available.' });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  }

  async function loadMore() {
    const last = ledger[ledger.length - 1];
    if (!last) return;
    const { entries } = await api.ledger(last.id);
    setLedger((prev) => [...prev, ...entries]);
    setMoreLedger(entries.length >= 50);
  }

  if (!info) return <div className="container page-message">{error ? <Alert kind="error">{error}</Alert> : <Spinner label="Loading billing…" />}</div>;

  const { credits, subscription, costs } = info;
  const plans = info.catalog.filter((c) => c.kind === 'plan');
  const packs = info.catalog.filter((c) => c.kind === 'pack');
  const canBuy = info.mode !== 'off';
  const low = credits.total <= info.lowCreditThreshold;

  return (
    <div className="container billing">
      <div className="page-head">
        <div>
          <h1>Credits &amp; billing</h1>
          <p className="muted">Credits pay for AI subtitles, translation and video export. Editing and SRT / VTT / TXT export are free.</p>
        </div>
      </div>

      {info.mode === 'demo' && <Alert kind="warning" title="Demo payments."><span data-testid="demo-banner">Payments on this server are in <strong>demo mode</strong>: checkout is simulated and <strong>no real money is charged</strong>. The server owner must configure Stripe to take real payments.</span></Alert>}
      {info.mode === 'off' && <Alert kind="info" title="Purchases are turned off.">{info.note || 'The server owner has disabled payments.'}</Alert>}
      {message && <Alert kind={message.kind} onClose={() => setMessage(null)}>{message.text}</Alert>}
      {error && <Alert kind="error" onClose={() => setError(null)}>{error}</Alert>}
      {low && <Alert kind="warning" title={credits.total === 0 ? 'You are out of credits.' : 'Credits are running low.'}>Buy a pack or subscribe below, or wait for your free credits on {new Date(credits.freeResetsAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}.</Alert>}

      <section className="balance-grid" aria-label="Your balance">
        <div className="card panel balance-main">
          <span className="muted small">Available credits</span>
          <strong className="balance-number" data-testid="balance-total">{credits.total}</strong>
        </div>
        <div className="card panel">
          <span className="muted small">Free this month</span>
          <strong className="balance-sub" data-testid="balance-free">{credits.free} <span className="muted small">/ {credits.freeMonthly}</span></strong>
          <span className="muted small">Unused free credits expire on {new Date(credits.freeResetsAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}, then renew.</span>
        </div>
        <div className="card panel">
          <span className="muted small">Purchased credits</span>
          <strong className="balance-sub" data-testid="balance-paid">{credits.paid}</strong>
          <span className="muted small">Never expire. Used after your free credits.</span>
        </div>
        <div className="card panel">
          <span className="muted small">Plan</span>
          <strong className="balance-sub" data-testid="plan-name">{subscription.plan === 'free' ? 'Free' : subscription.plan[0].toUpperCase() + subscription.plan.slice(1)}</strong>
          {subscription.planRenewsAt && <span className="muted small">Renews {new Date(subscription.planRenewsAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</span>}
          {subscription.canManageSubscription && <button type="button" className="btn btn-sm" onClick={() => void portal()} disabled={busy === 'portal'}>Manage subscription</button>}
          {info.mode === 'demo' && subscription.plan !== 'free' && <button type="button" className="btn btn-sm" onClick={() => void cancelDemo()} disabled={busy === 'cancel'}>End demo subscription</button>}
        </div>
      </section>

      <h2 className="section-title">Subscription plans</h2>
      <div className="plan-grid">
        {plans.map((plan) => {
          const current = subscription.plan === plan.id;
          return (
            <article key={plan.id} className={`card panel plan${current ? ' is-current' : ''}`} data-testid={`plan-${plan.id}`}>
              <h3>{plan.name}</h3>
              <p className="price">{formatMoney(plan.amount, plan.currency)}<span className="muted small"> / month</span></p>
              <p>{plan.description}</p>
              <p className="muted small">Credits are added every billing period and never expire.</p>
              <button type="button" className="btn btn-primary" disabled={!canBuy || current || busy !== null || (subscription.plan !== 'free' && info.mode === 'stripe')} onClick={() => void buy(plan)}>
                {current ? 'Current plan' : busy === plan.id ? 'Please wait…' : `Subscribe to ${plan.name}`}
              </button>
            </article>
          );
        })}
      </div>

      <h2 className="section-title">Credit packs</h2>
      <div className="plan-grid">
        {packs.map((pack) => (
          <article key={pack.id} className="card panel plan" data-testid={`pack-${pack.id}`}>
            <h3>{pack.name}</h3>
            <p className="price">{formatMoney(pack.amount, pack.currency)}</p>
            <p>{pack.description}</p>
            <button type="button" className="btn" disabled={!canBuy || busy !== null} onClick={() => void buy(pack)}>{busy === pack.id ? 'Please wait…' : 'Buy pack'}</button>
          </article>
        ))}
      </div>
      <p className="muted small">Prices shown are examples set by the server owner in <code>server/src/services/billing.ts</code>.</p>

      <h2 className="section-title">What things cost</h2>
      <ul className="cost-list">
        <li><strong>{costs.transcribePerMinute} credit{costs.transcribePerMinute === 1 ? '' : 's'}</strong> per started minute of video: speech-to-text subtitles</li>
        <li><strong>1 credit</strong> per {costs.translateMinutesPerCredit} started minute{costs.translateMinutesPerCredit === 1 ? '' : 's'}: translation of the whole project</li>
        <li><strong>1 credit</strong> per {costs.renderMinutesPerCredit} started minute{costs.renderMinutesPerCredit === 1 ? '' : 's'}: video export with burned-in subtitles</li>
        <li><strong>Free:</strong> trimming, voice-over, manual editing, styling, SRT / VTT / TXT files</li>
      </ul>

      <h2 className="section-title">Credit history</h2>
      {ledger.length === 0 ? <p className="empty">No activity yet.</p> : (
        <div className="table-wrap">
          <table className="table" data-testid="ledger">
            <thead><tr><th>Date</th><th>What</th><th className="num">Credits</th><th className="num">Balance</th></tr></thead>
            <tbody>
              {ledger.map((e) => (
                <tr key={e.id}>
                  <td>{date(e.createdAt)}</td>
                  <td>{KIND_LABEL[e.kind] ?? e.kind}{e.description ? <span className="muted small"> · {e.description}</span> : null}</td>
                  <td className={`num ${e.delta < 0 ? 'neg' : 'pos'}`}>{e.delta > 0 ? `+${e.delta}` : e.delta}</td>
                  <td className="num">{e.freeAfter + e.paidAfter}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {moreLedger && ledger.length > 0 && <button type="button" className="btn btn-sm" onClick={() => void loadMore()}>Show older</button>}

      <h2 className="section-title">Purchase history</h2>
      {payments.length === 0 ? <p className="empty">No purchases yet.</p> : (
        <div className="table-wrap">
          <table className="table" data-testid="payments">
            <thead><tr><th>Date</th><th>Item</th><th className="num">Amount</th><th className="num">Credits</th><th>Status</th></tr></thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id}>
                  <td>{date(p.createdAt)}</td>
                  <td>{p.description}{p.provider === 'demo' ? <span className="chip chip-draft"> demo</span> : null}</td>
                  <td className="num">{formatMoney(p.amount, p.currency)}</td>
                  <td className="num">{p.credits}</td>
                  <td><span className={`chip chip-pay-${p.status}`}>{p.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
