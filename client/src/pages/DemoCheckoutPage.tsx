import { useEffect, useState } from 'react';
import { Alert, Spinner } from '../components/ui';
import { api, describeError } from '../lib/api';
import { formatMoney } from '../lib/money';
import { useRouter } from '../lib/router';

/** Fake checkout used when PAYMENTS_MODE=demo. It looks like a payment page but charges nothing. */
export function DemoCheckoutPage({ id }: { id: string }) {
  const { navigate } = useRouter();
  const [payment, setPayment] = useState<{ description: string; amount: number; currency: string; credits: number; status: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.demoPayment(id).then((r) => setPayment(r.payment)).catch((e) => setError(describeError(e)));
  }, [id]);

  async function finish(pay: boolean) {
    setBusy(true);
    try {
      if (pay) await api.demoPay(id);
      else await api.demoCancel(id);
      navigate(`/billing?checkout=${pay ? 'demo-paid' : 'canceled'}`);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  return (
    <div className="container auth-wrap">
      <div className="card auth-card">
        <Alert kind="warning" title="Demo checkout.">No real money is charged and no card is needed. This page only simulates a payment so you can test credits, history and notifications.</Alert>
        {error && <Alert kind="error">{error}</Alert>}
        {!payment && !error && <Spinner label="Loading…" />}
        {payment && (
          <>
            <h1 className="auth-title">{payment.description}</h1>
            <p className="price">{formatMoney(payment.amount, payment.currency)}</p>
            <p>You receive <strong>{payment.credits} credits</strong>.</p>
            {payment.status !== 'pending' ? (
              <Alert kind="info">This checkout is already {payment.status}.</Alert>
            ) : (
              <div className="row gap wrap">
                <button type="button" className="btn btn-primary" onClick={() => void finish(true)} disabled={busy} data-testid="demo-pay">Pay (demo, free)</button>
                <button type="button" className="btn" onClick={() => void finish(false)} disabled={busy}>Cancel</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
