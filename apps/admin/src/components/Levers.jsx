import { useState } from 'react';
import { parseGBPToPennies } from '@gm-referral/shared/money';
import { api } from '../api/client.js';
import { Card } from './ui.jsx';

const penniesToPounds = (pennies) => (pennies / 100).toFixed(2).replace(/\.00$/, '');

export default function Levers({ commissionPennies, settings, onChanged, notify }) {
  const [commission, setCommission] = useState(commissionPennies == null ? '' : penniesToPounds(commissionPennies));
  const [threshold, setThreshold] = useState(penniesToPounds(Number(settings.payout_threshold_pennies ?? 0)));
  const [expiry, setExpiry] = useState(String(settings.payout_expiry_days ?? ''));
  const [saving, setSaving] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    const newCommission = parseGBPToPennies(commission);
    const newThreshold = parseGBPToPennies(threshold);
    if (newCommission == null || newCommission <= 0 || newThreshold == null || newThreshold <= 0) {
      return notify('Enter valid £ amounts');
    }
    setSaving(true);
    try {
      if (newCommission !== commissionPennies) {
        await api('/admin/reward-amount', { method: 'PUT', body: { amountPennies: newCommission } });
      }
      const changes = {};
      if (newThreshold !== Number(settings.payout_threshold_pennies)) changes.payout_threshold_pennies = newThreshold;
      if (expiry !== String(settings.payout_expiry_days ?? '')) changes.payout_expiry_days = Number(expiry);
      if (Object.keys(changes).length > 0) {
        await api('/admin/settings', { method: 'PUT', body: changes });
      }
      onChanged();
    } catch (err) {
      notify(err.code ?? 'save_failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title="Reward levers" className="levers">
      <form onSubmit={save}>
        <label htmlFor="lever-commission">Commission per referral (£)</label>
        <input id="lever-commission" type="text" inputMode="decimal" value={commission} onChange={(e) => setCommission(e.target.value)} />
        <label htmlFor="lever-threshold">Payout threshold (£)</label>
        <input id="lever-threshold" type="text" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        <label htmlFor="lever-expiry">Payout expiry (days)</label>
        <input id="lever-expiry" type="text" inputMode="numeric" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        <button type="submit" disabled={saving}>Save changes</button>
      </form>
      <p className="fineprint">Changes apply to future confirmations and requests only.</p>
    </Card>
  );
}
