import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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
    const onMoved = vi.fn();
    const onChanged = vi.fn();
    render(<PipelineBoard referrals={referrals} onMoved={onMoved} onChanged={onChanged} notify={vi.fn()} />);

    expect(screen.getByText('Jane Smith')).toBeInTheDocument();
    expect(screen.getByText('Tom Hall')).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/status for jane smith/i), 'contacted');

    expect(calls).toEqual([
      { method: 'PATCH', path: '/admin/referrals/r1/status', body: { status: 'contacted' } },
    ]);
    // One row moved, so one row is patched. Reloading the whole dashboard here cost eleven
    // requests against a remote database and left the board waiting on the slowest of them.
    await vi.waitFor(() => expect(onMoved).toHaveBeenCalledWith('r1', 'contacted'));
    expect(onChanged, 'an ordinary move must not trigger a full dashboard reload').not.toHaveBeenCalled();
  });

  it('does reload the dashboard when the move credits commission — the money figures moved too', async () => {
    const withAgreed = [
      ...referrals,
      { id: 'r3', referred_name: 'Ann Ford', referred_phone: '+447700900111', status: 'treatment_agreed', treatment_interest: 'veneers', practice: 'Ashford', referrer: 'Sarah Lewis', treatment_name: 'Veneers x6', doctor_name: 'Dr Patel', treatment_value_pennies: 480000 },
    ];
    stubFetchRoutes([{ method: 'PATCH', path: '/admin/referrals/r3/status' }]);
    const onChanged = vi.fn();
    render(<PipelineBoard referrals={withAgreed} onMoved={vi.fn()} onChanged={onChanged} notify={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for ann ford/i), 'treatment_started');
    await userEvent.click(screen.getByRole('button', { name: /credit .*commission/i }));

    // The liability figure above the board and the payout queue behind it are both stale now.
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('offers only the moves the API will actually accept', async () => {
    // updateStatus allows the next stage, either crediting stage ahead of the card, or lost.
    // Every other option answered 409, so listing them made the control lie.
    render(<PipelineBoard referrals={referrals} onMoved={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} />);

    const options = (name) =>
      [...screen.getByLabelText(new RegExp(`status for ${name}`, 'i')).options].map((o) => o.value);

    // Jane is New: Contacted next, the two crediting stages, and Lost — never a step backwards.
    expect(options('jane smith')).toEqual(['new', 'contacted', 'treatment_started', 'treatment_completed', 'lost']);
    // Tom is Booked, so New and Contacted are behind him and must not be offered.
    expect(options('tom hall')).toEqual(['booked', 'attended', 'treatment_started', 'treatment_completed', 'lost']);
  });

  it('shows no move control at all on a card that has nowhere left to go', async () => {
    const finished = [
      { id: 'r5', referred_name: 'Dee Done', referred_phone: '+447700900333', status: 'treatment_completed', treatment_interest: 'implants', practice: 'Barnet', referrer: 'Sarah Lewis' },
      { id: 'r6', referred_name: 'Lee Lost', referred_phone: '+447700900444', status: 'lost', treatment_interest: 'implants', practice: 'Barnet', referrer: 'Sarah Lewis' },
    ];
    render(<PipelineBoard referrals={finished} onMoved={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} />);

    expect(screen.queryByLabelText(/status for dee done/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/status for lee lost/i)).not.toBeInTheDocument();
    expect(screen.getByText(/completed — no further moves/i)).toBeInTheDocument();
    expect(screen.getByText(/lost — no further moves/i)).toBeInTheDocument();
  });

  it('never sends the raw column value to the screen', async () => {
    // `not_sure` is a stored enum, not something to show a person.
    render(<PipelineBoard referrals={[{ ...referrals[0], treatment_interest: 'not_sure' }]} onMoved={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} />);
    expect(screen.queryByText(/not_sure/)).not.toBeInTheDocument();
    expect(screen.getByText(/undecided/i)).toBeInTheDocument();
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
      { id: 'r3', referred_name: 'Ann Ford', referred_phone: '+447700900111', status: 'treatment_agreed', treatment_interest: 'veneers', practice: 'Ashford', referrer: 'Sarah Lewis', treatment_name: 'Veneers x6', doctor_name: 'Dr Patel', treatment_value_pennies: 480000 },
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

  it('also asks for confirmation moving straight to Completed — not just treatment_started', async () => {
    // updateStatus credits on EITHER treatment_started or treatment_completed (the "at or past"
    // rule), and every status renders as both a droppable column and a <select> option — so a
    // manager could previously jump a card straight to Completed and credit the same money with
    // one click and no confirmation. That must raise the identical inline confirm.
    const calls = stubFetchRoutes([{ method: 'PATCH', path: '/admin/referrals/r3/status' }]);
    const withAgreed = [
      ...referrals,
      { id: 'r3', referred_name: 'Ann Ford', referred_phone: '+447700900111', status: 'treatment_started', treatment_interest: 'veneers', practice: 'Ashford', referrer: 'Sarah Lewis', treatment_name: 'Veneers x6', doctor_name: 'Dr Patel', treatment_value_pennies: 480000 },
    ];
    render(<PipelineBoard referrals={withAgreed} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for ann ford/i), 'treatment_completed');
    expect(calls, 'money must not move on a single click, even for Completed').toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: /credit .*commission/i }));

    expect(calls).toEqual([
      { method: 'PATCH', path: '/admin/referrals/r3/status', body: { status: 'treatment_completed' } },
    ]);
  });

  it('lets the confirmation be cancelled without sending anything', async () => {
    const calls = stubFetchRoutes([{ method: 'PATCH', path: '/admin/referrals/r3/status' }]);
    const withAgreed = [
      ...referrals,
      { id: 'r3', referred_name: 'Ann Ford', referred_phone: '+447700900111', status: 'treatment_agreed', treatment_interest: 'veneers', practice: 'Ashford', referrer: 'Sarah Lewis', treatment_name: 'Veneers x6', doctor_name: 'Dr Patel', treatment_value_pennies: 480000 },
    ];
    render(<PipelineBoard referrals={withAgreed} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for ann ford/i), 'treatment_started');
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(calls).toHaveLength(0);
  });

  it('renders a column for the new treatment started stage, with the referral inside it', async () => {
    const withStarted = [
      ...referrals,
      { id: 'r4', referred_name: 'Bo Barnet', referred_phone: '+447700900222', status: 'treatment_started', treatment_interest: 'implants', practice: 'Barnet', referrer: 'Sarah Lewis' },
    ];
    const { container } = render(<PipelineBoard referrals={withStarted} onChanged={vi.fn()} notify={vi.fn()} />);
    // Every heading renders unconditionally now, so asserting the heading exists alone would
    // pass even if grouping were broken — scope to the column itself and check who's in it.
    const column = container.querySelector('[data-stage="treatment_started"]');
    expect(column).not.toBeNull();
    expect(within(column).getByText('Bo Barnet')).toBeInTheDocument();
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

    const contactedGroup = screen.getByRole('heading', { name: /^contacted/i }).closest('.board-col');
    const newGroup = screen.getByRole('heading', { name: /^new/i }).closest('.board-col');
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
    const newGroup = screen.getByRole('heading', { name: /^new/i }).closest('.board-col');
    const contactedGroup = screen.getByRole('heading', { name: /^contacted/i }).closest('.board-col');
    expect(newGroup).toHaveTextContent('Jane Smith');
    expect(contactedGroup).not.toHaveTextContent('Jane Smith');
  });

  it('drops a stale optimistic override once fresh data disagrees with it', async () => {
    const calls = stubFetchRoutes([{ method: 'PATCH', path: '/admin/referrals/r1/status' }]);
    const { rerender } = render(<PipelineBoard referrals={referrals} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for jane smith/i), 'contacted');
    await vi.waitFor(() => expect(calls).toHaveLength(1));

    const contactedGroup = () => screen.getByRole('heading', { name: /^contacted/i }).closest('.board-col');
    expect(contactedGroup()).toHaveTextContent('Jane Smith');

    // A colleague (or the Dentally sync) has since moved this same referral on to Booked. The
    // next poll (App.jsx refetches every 30s) hands the board fresh props saying so.
    const movedByColleague = referrals.map((r) => (r.id === 'r1' ? { ...r, status: 'booked' } : r));
    rerender(<PipelineBoard referrals={movedByColleague} onChanged={vi.fn()} notify={vi.fn()} />);

    const bookedGroup = () => screen.getByRole('heading', { name: /^booked/i }).closest('.board-col');
    await vi.waitFor(() => expect(within(bookedGroup()).getByText('Jane Smith')).toBeInTheDocument());
    expect(contactedGroup()).not.toHaveTextContent('Jane Smith');
  });

  it('does not let a stale failed request roll back a newer successful move', async () => {
    // Two in-flight PATCHes for the same card: the first (New -> Contacted) hangs, the second
    // (Contacted -> Booked, fired once the confirm-lost/credit gates are out of the way) resolves
    // first and succeeds. When the first one finally rejects, it must not undo the second.
    let rejectFirst;
    let resolveSecond;
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(() => {
      call += 1;
      if (call === 1) return new Promise((_resolve, reject) => { rejectFirst = reject; });
      return new Promise((resolve) => { resolveSecond = resolve; });
    }));
    render(<PipelineBoard referrals={referrals} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for jane smith/i), 'contacted');
    await userEvent.selectOptions(screen.getByLabelText(/status for jane smith/i), 'booked');

    const bookedGroup = () => screen.getByRole('heading', { name: /^booked/i }).closest('.board-col');
    expect(within(bookedGroup()).getByText('Jane Smith')).toBeInTheDocument();

    resolveSecond(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await vi.waitFor(() => expect(within(bookedGroup()).getByText('Jane Smith')).toBeInTheDocument());

    rejectFirst(Object.assign(new Error('stale'), { code: 'invalid_transition' }));
    // Give the rejected promise's catch a turn to (not) run.
    await new Promise((r) => setTimeout(r, 0));
    expect(within(bookedGroup()).getByText('Jane Smith')).toBeInTheDocument();
  });
});

// The card is a door, not a dossier: a name and two lines on the face, everything else behind
// a click. The two fields the practice fills in itself are stored, not page state.
describe('the card and its record', () => {
  const detail = {
    patient: {
      id: 'r1', name: 'Jane Smith', phone: '+447700900456', email: 'jane@example.com',
      status: 'new', treatmentInterest: 'implants', treatmentName: null,
      source: 'code', lostReason: null, referredAt: '2026-09-01T10:00:00.000Z',
    },
    referrer: { id: 'u1', name: 'Sarah Lewis', phone: '+447700900111', code: 'ABC123' },
    practice: { chosen: 'Sidcup', booked: null },
    appointment: { startsAt: null, dentallyId: null },
    commission: { amountPennies: null, creditedAt: null },
    notes: [],
    timeline: [],
  };

  it('keeps the card face to a glance, and everything else behind the click', async () => {
    stubFetchRoutes([{ method: 'GET', path: '/admin/referrals/r1', body: detail }]);
    render(<PipelineBoard referrals={referrals} onMoved={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} />);

    // Not on the face: the referrer, the phone, the email — the card carries the patient's
    // name, what they're having done, and where.
    expect(screen.queryByText(/sarah lewis/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\+447700900456/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /jane smith/i }));

    expect(await screen.findByText('Sarah Lewis')).toBeInTheDocument();
    // The phone is in the dialog's own header line as well, so scope to the record itself.
    const record = screen.getByRole('dialog');
    expect(within(record).getAllByText(/\+447700900456/).length).toBeGreaterThan(0);
    expect(screen.getByText('jane@example.com')).toBeInTheDocument();
    expect(screen.getByText(/code ABC123/)).toBeInTheDocument();
  });

  it('shows the typed treatment on the card once it is saved, in place of the form answer', async () => {
    const calls = stubFetchRoutes([
      { method: 'GET', path: '/admin/referrals/r1', body: detail },
      { method: 'PUT', path: '/admin/referrals/r1/treatment', body: { treatmentName: 'Upper arch implants', doctorName: 'Dr Patel', treatmentValuePennies: 480000 } },
    ]);
    const onCardEdited = vi.fn();
    render(
      <PipelineBoard
        referrals={referrals}
        onMoved={vi.fn()}
        onCardEdited={onCardEdited}
        onChanged={vi.fn()}
        notify={vi.fn()}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: /jane smith/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^treatment$/i }));
    await userEvent.type(screen.getByLabelText(/^treatment/i), 'Upper arch implants');
    await userEvent.type(screen.getByLabelText(/^dentist/i), 'Dr Patel');
    await userEvent.type(screen.getByLabelText(/^value/i), '4800');
    await userEvent.click(screen.getByRole('button', { name: /save treatment/i }));

    await vi.waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PUT',
        path: '/admin/referrals/r1/treatment',
        body: { treatmentName: 'Upper arch implants', doctorName: 'Dr Patel', treatmentValuePennies: 480000 },
      }),
    );
    // The board is told, so the card face updates without refetching the whole list.
    expect(onCardEdited).toHaveBeenCalledWith('r1', {
      treatment_name: 'Upper arch implants',
      doctor_name: 'Dr Patel',
      treatment_value_pennies: 480000,
    });
  });

  it('adds and deletes notes, taking the stored list back from each write', async () => {
    const afterAdd = [{ id: 'n1', body: 'Rang twice.', author: 'a@x.co', createdAt: '2026-09-02T09:00:00.000Z' }];
    stubFetchRoutes([
      { method: 'GET', path: '/admin/referrals/r1', body: detail },
      { method: 'POST', path: '/admin/referrals/r1/notes', body: { id: 'n1', notes: afterAdd } },
      { method: 'DELETE', path: '/admin/referrals/r1/notes/n1', body: { ok: true, notes: [] } },
    ]);
    render(<PipelineBoard referrals={referrals} onMoved={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /jane smith/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^notes$/i }));
    expect(screen.getByText(/no notes yet/i)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/add a note/i), 'Rang twice.');
    await userEvent.click(screen.getByRole('button', { name: /^add note$/i }));

    // What comes back from the write IS the stored list — no follow-up read to race.
    expect(await screen.findByText('Rang twice.')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(await screen.findByText(/no notes yet/i)).toBeInTheDocument();
  });

  it('will not send an empty note', async () => {
    const calls = stubFetchRoutes([{ method: 'GET', path: '/admin/referrals/r1', body: detail }]);
    render(<PipelineBoard referrals={referrals} onMoved={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /jane smith/i }));
    await userEvent.click(await screen.findByRole('button', { name: /^notes$/i }));
    expect(screen.getByRole('button', { name: /^add note$/i })).toBeDisabled();
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });
});

// Treatment started is where the money moves. The API refuses it while the treatment, the
// dentist or the value is missing, so the board must not offer the move and then explain a
// failure afterwards — it opens the one screen that fixes it.
describe('starting treatment needs the treatment on record', () => {
  const bare = [
    {
      id: 'r9', referred_name: 'Nia Blank', referred_phone: '+447700900999', status: 'treatment_agreed',
      treatment_interest: 'implants', practice: 'Ashford', referrer: 'Sarah Lewis',
      treatment_name: null, doctor_name: null, treatment_value_pennies: null,
    },
  ];
  const detailFor = (patch = {}) => ({
    patient: {
      id: 'r9', name: 'Nia Blank', phone: '+447700900999', email: null, status: 'treatment_agreed',
      treatmentInterest: 'implants', treatmentName: null, doctorName: null, treatmentValuePennies: null,
      source: 'code', lostReason: null, referredAt: '2026-09-01T10:00:00.000Z', ...patch,
    },
    referrer: { id: 'u1', name: 'Sarah Lewis', phone: '+447700900111', code: 'ABC123' },
    practice: { chosen: 'Ashford', booked: null },
    appointment: { startsAt: null, dentallyId: null },
    commission: { amountPennies: null, creditedAt: null },
    notes: [],
    timeline: [],
  });

  it('opens the record on Treatment and sends nothing, instead of failing the move', async () => {
    const calls = stubFetchRoutes([{ method: 'GET', path: '/admin/referrals/r9', body: detailFor() }]);
    render(<PipelineBoard referrals={bare} onMoved={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for nia blank/i), 'treatment_started');

    expect(await screen.findByText(/can’t start treatment until all three are filled in/i)).toBeInTheDocument();
    // Not a confirm-then-fail: the PATCH was never sent.
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(0);
    // And all three fields are marked as required, not merely present.
    expect(screen.getByLabelText(/^treatment/i)).toBeRequired();
    expect(screen.getByLabelText(/^dentist/i)).toBeRequired();
    expect(screen.getByLabelText(/^value/i)).toBeRequired();
  });

  it('saves the three facts and makes the move in one go', async () => {
    const calls = stubFetchRoutes([
      { method: 'GET', path: '/admin/referrals/r9', body: detailFor() },
      {
        method: 'PUT',
        path: '/admin/referrals/r9/treatment',
        body: { treatmentName: 'Full arch', doctorName: 'Dr Okafor', treatmentValuePennies: 650000 },
      },
      { method: 'PATCH', path: '/admin/referrals/r9/status' },
    ]);
    const onMoved = vi.fn();
    render(<PipelineBoard referrals={bare} onMoved={onMoved} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for nia blank/i), 'treatment_started');
    await userEvent.type(await screen.findByLabelText(/^treatment/i), 'Full arch');
    await userEvent.type(screen.getByLabelText(/^dentist/i), 'Dr Okafor');
    await userEvent.type(screen.getByLabelText(/^value/i), '6500');

    // The button says what it is about to do — save AND start treatment, not just save.
    await userEvent.click(screen.getByRole('button', { name: /save and start treatment/i }));

    await vi.waitFor(() =>
      expect(calls).toContainEqual({
        method: 'PATCH',
        path: '/admin/referrals/r9/status',
        body: { status: 'treatment_started' },
      }),
    );
    // The save came first: the API rejects the move if the details are not already stored.
    const putIndex = calls.findIndex((c) => c.method === 'PUT');
    const patchIndex = calls.findIndex((c) => c.method === 'PATCH');
    expect(putIndex).toBeLessThan(patchIndex);
    await vi.waitFor(() => expect(onMoved).toHaveBeenCalledWith('r9', 'treatment_started'));
  });

  it('refuses a value that is not money, without sending anything', async () => {
    const calls = stubFetchRoutes([{ method: 'GET', path: '/admin/referrals/r9', body: detailFor() }]);
    render(<PipelineBoard referrals={bare} onMoved={vi.fn()} onChanged={vi.fn()} notify={vi.fn()} />);

    await userEvent.selectOptions(screen.getByLabelText(/status for nia blank/i), 'treatment_started');
    await userEvent.type(await screen.findByLabelText(/^value/i), 'about four grand');

    expect(screen.getByText(/type an amount in pounds/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled();
    expect(calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });
});
