import { useState } from 'react';
import { parseGBPToPennies } from '@gm-referral/shared/money';
import { api } from '../api/client.js';
import { Card } from './ui.jsx';

const penniesToPounds = (pennies) => (pennies / 100).toFixed(2).replace(/\.00$/, '');

/**
 * The payout levers.
 *
 * "Commission per referral" used to live here as a single global figure, written to
 * reward_rules. It is gone (2026-09-11): the practice manager now picks a commission per
 * referral from a fixed set of tiers, on the referral's own record in the pipeline. Leaving
 * the field would have let an owner carefully set a number that changed nothing — worse than
 * not offering it, because it looks like a control.
 *
 * What remains is genuinely global: when someone may cash out, and how long a request lives.
 */
export default function Levers({ settings, onChanged, notify }) {
  const [threshold, setThreshold] = useState(penniesToPounds(Number(settings.payout_threshold_pennies ?? 0)));
  const [expiry, setExpiry] = useState(String(settings.payout_expiry_days ?? ''));
  const [saving, setSaving] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    const newThreshold = parseGBPToPennies(threshold);
    if (newThreshold == null || newThreshold <= 0) {
      return notify('Enter a valid £ amount');
    }
    setSaving(true);
    try {
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
    <Card title="Payout levers" className="levers">
      <form onSubmit={save}>
        <label htmlFor="lever-threshold">Payout threshold (£)</label>
        <input id="lever-threshold" type="text" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        <label htmlFor="lever-expiry">Payout expiry (days)</label>
        <input id="lever-expiry" type="text" inputMode="numeric" value={expiry} onChange={(e) => setExpiry(e.target.value)} />
        <button type="submit" disabled={saving}>Save changes</button>
      </form>
      <p className="fineprint">
        Commission is set per referral on the pipeline card, not here. Changes apply to future
        requests only.
      </p>
    </Card>
  );
}
