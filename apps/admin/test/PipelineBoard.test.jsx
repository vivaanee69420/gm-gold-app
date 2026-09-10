import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PipelineBoard from '../src/components/PipelineBoard.jsx';
import { clearToken, setToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

const referrals = [
  { id: 'r1', referred_name: 'Jane Smith', referred_phone: '+447700900456', status: 'new', treatment_interest: 'implants', practice: 'Sidcup', referrer: 'Sarah Lewis' },
  { id: 'r2', referred_name: 'Tom Hall', referred_phone: '+447700900789', status: 'booked', treatment_interest: 'aligners', practice: 'Bexley', referrer: 'Sarah Lewis' },
];

beforeEach(() => {
  clearToken();
  setToken('tok');
});
afterEach(() => vi.unstubAllGlobals());

describe('PipelineBoard', () => {
  it('advances a referral to an adjacent status', async () => {
    const calls = stubFetchRoutes([{ method: 'PATCH', path: '/admin/referrals/r1/status' }]);
    const onChanged = vi.fn();
    render(<PipelineBoard referrals={referrals} onChanged={onChanged} notify={vi.fn()} />);

    expect(screen.getByText('Jane Smith')).toBeInTheDocument();
    expect(screen.getByText('Tom Hall')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/status for jane smith/i), 'contacted');

    expect(calls).toEqual([
      { method: 'PATCH', path: '/admin/referrals/r1/status', body: { status: 'contacted' } },
    ]);
    expect(onChanged).toHaveBeenCalled();
  });

  it('requires a reason before marking a referral lost', async () => {
    const calls = stubFetchRoutes([{ method: 'PATCH', path: '/admin/referrals/r2/status' }]);
    render(<PipelineBoard referrals={referrals} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for tom hall/i), 'lost');
    expect(calls).toHaveLength(0); // nothing sent until a reason is confirmed

    await userEvent.type(screen.getByLabelText(/lost reason for tom hall/i), 'moved away');
    await userEvent.click(screen.getByRole('button', { name: /confirm lost/i }));

    expect(calls).toEqual([
      { method: 'PATCH', path: '/admin/referrals/r2/status', body: { status: 'lost', lostReason: 'moved away' } },
    ]);
  });

  it('asks for confirmation before the stage that credits commission', async () => {
    const calls = stubFetchRoutes([{ method: 'PATCH', path: '/admin/referrals/r3/status' }]);
    const withAgreed = [
      ...referrals,
      { id: 'r3', referred_name: 'Ann Ford', referred_phone: '+447700900111', status: 'treatment_agreed', treatment_interest: 'veneers', practice: 'Ashford', referrer: 'Sarah Lewis' },
    ];
    render(<PipelineBoard referrals={withAgreed} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for ann ford/i), 'treatment_started');
    expect(calls, 'money must not move on a single click').toHaveLength(0);

    // An inline step, never a browser confirm() — a modal dialog would block the extension.
    await userEvent.click(screen.getByRole('button', { name: /credit .*commission/i }));

    expect(calls).toEqual([
      { method: 'PATCH', path: '/admin/referrals/r3/status', body: { status: 'treatment_started' } },
    ]);
  });

  it('lets the confirmation be cancelled without sending anything', async () => {
    const calls = stubFetchRoutes([{ method: 'PATCH', path: '/admin/referrals/r3/status' }]);
    const withAgreed = [
      ...referrals,
      { id: 'r3', referred_name: 'Ann Ford', referred_phone: '+447700900111', status: 'treatment_agreed', treatment_interest: 'veneers', practice: 'Ashford', referrer: 'Sarah Lewis' },
    ];
    render(<PipelineBoard referrals={withAgreed} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for ann ford/i), 'treatment_started');
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(calls).toHaveLength(0);
  });

  it('renders a column for the new treatment started stage', async () => {
    const withStarted = [
      ...referrals,
      { id: 'r4', referred_name: 'Bo Barnet', referred_phone: '+447700900222', status: 'treatment_started', treatment_interest: 'implants', practice: 'Barnet', referrer: 'Sarah Lewis' },
    ];
    render(<PipelineBoard referrals={withStarted} onChanged={vi.fn()} notify={vi.fn()} />);
    expect(screen.getByRole('heading', { name: /treatment started/i })).toBeInTheDocument();
  });

  it('renders a column for every stage even when empty', async () => {
    render(<PipelineBoard referrals={referrals} onChanged={vi.fn()} notify={vi.fn()} />);
    // 'new' and 'booked' are occupied by the fixture referrals; the rest have nobody in them
    // yet, and must still show up as columns rather than being skipped.
    for (const label of ['Contacted', 'Attended', 'Treatment agreed', 'Treatment started', 'Completed', 'Lost']) {
      expect(screen.getByRole('heading', { name: new RegExp(label, 'i') })).toBeInTheDocument();
    }
  });

  it('moves a card immediately, before the request resolves', async () => {
    // A fetch we control by hand, so we can inspect the board mid-flight instead of racing the
    // stubbed promise's own microtask resolution.
    let resolveFetch;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => { resolveFetch = resolve; })));
    render(<PipelineBoard referrals={referrals} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for jane smith/i), 'contacted');

    const contactedGroup = screen.getByRole('heading', { name: /^contacted/i }).closest('.pipeline-group');
    const newGroup = screen.getByRole('heading', { name: /^new/i }).closest('.pipeline-group');
    // The card is under Contacted right away — the request is still pending.
    expect(contactedGroup).toHaveTextContent('Jane Smith');
    expect(newGroup).not.toHaveTextContent('Jane Smith');

    // Resolving success leaves it there — no flicker back to New while fresh data is refetched.
    resolveFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await vi.waitFor(() => expect(contactedGroup).toHaveTextContent('Jane Smith'));
    expect(newGroup).not.toHaveTextContent('Jane Smith');
  });

  it('rolls a card back to its original column on failure, with a toast explaining why', async () => {
    // A referral that fell out of the manager's scope between page load and click — the API's
    // documented 404 for this endpoint.
    stubFetchRoutes([{ method: 'PATCH', path: '/admin/referrals/r1/status', status: 404, body: { error: 'not_found' } }]);
    const notify = vi.fn();
    render(<PipelineBoard referrals={referrals} onChanged={vi.fn()} notify={notify} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for jane smith/i), 'contacted');

    // The request fails, so the card returns to New and the failure is explained with copy for
    // this screen, not the account-scoped "not_found" message reused elsewhere in the app.
    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('referral_not_found'));
    const newGroup = screen.getByRole('heading', { name: /^new/i }).closest('.pipeline-group');
    const contactedGroup = screen.getByRole('heading', { name: /^contacted/i }).closest('.pipeline-group');
    expect(newGroup).toHaveTextContent('Jane Smith');
    expect(contactedGroup).not.toHaveTextContent('Jane Smith');
  });
});
