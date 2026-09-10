import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PatientsPage from '../src/pages/PatientsPage.jsx';
import { clearToken, setToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

const patients = [
  {
    id: 'r1',
    referred_name: 'Percy Patient',
    referred_phone: '+447700900456',
    referred_email: 'percy@example.com',
    status: 'booked',
    practice: 'Ashford',
    referrer: 'Rita Referrer',
    created_at: '2026-09-01',
    appointment_starts_at: '2026-09-20T10:00:00Z',
    commission_pennies: null,
  },
  {
    id: 'r2',
    referred_name: 'Quinn Quiet',
    referred_phone: '+447700900789',
    status: 'treatment_started',
    practice: 'Barnet',
    referrer: 'Rita Referrer',
    created_at: '2026-09-02',
    commission_pennies: 10000,
  },
];

const detail = {
  patient: { id: 'r1', name: 'Percy Patient', phone: '+447700900456', email: 'percy@example.com', status: 'booked', referredAt: '2026-09-01T09:00:00Z' },
  referrer: { id: 'u1', name: 'Rita Referrer', phone: '+447700900123', code: 'ABCD2345' },
  practice: { chosen: 'Ashford', booked: 'Barnet' },
  appointment: { startsAt: '2026-09-20T10:00:00Z', dentallyId: 'appointment-9' },
  commission: { amountPennies: null, creditedAt: null },
  timeline: [
    { action: 'created', from: null, to: null, actorKind: 'user', actorEmail: null, at: '2026-09-01T09:00:00Z' },
    { action: 'status_changed', from: 'new', to: 'booked', actorKind: 'system', actorEmail: null, at: '2026-09-02T09:00:00Z' },
  ],
};

// Same practice both sides — the panel should show it once, not "chose Barnet ... Barnet".
const sameShopDetail = {
  ...detail,
  patient: { ...detail.patient, id: 'r2', name: 'Quinn Quiet', status: 'treatment_started' },
  practice: { chosen: 'Barnet', booked: 'Barnet' },
  commission: { amountPennies: 10000, creditedAt: '2026-09-05T09:00:00Z' },
  timeline: [],
};

beforeEach(() => {
  clearToken();
  setToken('tok');
});
afterEach(() => vi.unstubAllGlobals());

describe('PatientsPage', () => {
  it('lists patients with their referrer', () => {
    stubFetchRoutes([]);
    render(<PatientsPage data={{ patients }} notify={vi.fn()} />);
    expect(screen.getByText('Percy Patient')).toBeInTheDocument();
    expect(screen.getAllByText(/rita referrer/i).length).toBeGreaterThan(0);
  });

  it('labels every status, including the new treatment_started stage', () => {
    stubFetchRoutes([]);
    render(<PatientsPage data={{ patients }} notify={vi.fn()} />);
    expect(screen.getByText('Treatment started')).toBeInTheDocument();
    expect(screen.queryByText('undefined')).not.toBeInTheDocument();
  });

  it('filters by name, phone or referrer', async () => {
    stubFetchRoutes([]);
    render(<PatientsPage data={{ patients }} notify={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/search patients/i), 'quinn');
    expect(screen.queryByText('Percy Patient')).not.toBeInTheDocument();
    expect(screen.getByText('Quinn Quiet')).toBeInTheDocument();
  });

  it('shows an inviting empty state before any patient has been referred', () => {
    stubFetchRoutes([]);
    render(<PatientsPage data={{ patients: [] }} notify={vi.fn()} />);
    expect(screen.getByText(/no patients yet/i)).toBeInTheDocument();
  });

  it('opens the detail panel and shows referrer, appointment and timeline', async () => {
    stubFetchRoutes([{ method: 'GET', path: '/admin/patients/r1', body: detail }]);
    render(<PatientsPage data={{ patients }} notify={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /percy patient/i }));

    // The list's own Practice column already says "Ashford"/"Barnet" for other rows, so every
    // assertion below is scoped to the panel rather than the whole document.
    const panel = await screen.findByRole('complementary', { name: /percy patient/i });
    expect(within(panel).getByText('ABCD2345')).toBeInTheDocument();
    expect(within(panel).getByText(/\+447700900123/)).toBeInTheDocument();
    // Chose Ashford, booked Barnet — the mismatch has to be visible, not silently reconciled.
    expect(within(panel).getByText(/ashford/i)).toBeInTheDocument();
    expect(within(panel).getByText(/barnet/i)).toBeInTheDocument();
    expect(within(panel).getByText(/new → booked/i)).toBeInTheDocument();
    // A system-written entry says so in words, not a null actor.
    expect(within(panel).getByText(/the dentally sync/i)).toBeInTheDocument();
  });

  it('shows one practice, not a false mismatch, when chosen and booked match', async () => {
    stubFetchRoutes([{ method: 'GET', path: '/admin/patients/r2', body: sameShopDetail }]);
    render(<PatientsPage data={{ patients }} notify={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /quinn quiet/i }));
    const panel = await screen.findByRole('complementary', { name: /quinn quiet/i });

    await within(panel).findByText(/barnet/i);
    expect(within(panel).getAllByText(/barnet/i)).toHaveLength(1);
    expect(within(panel).queryByText(/chose barnet/i)).not.toBeInTheDocument();
  });

  it('is keyboard accessible: focus enters the panel, Escape closes it, and focus returns to the row', async () => {
    const user = userEvent.setup();
    stubFetchRoutes([{ method: 'GET', path: '/admin/patients/r1', body: detail }]);
    render(<PatientsPage data={{ patients }} notify={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: /percy patient/i });
    await user.click(trigger);

    const panel = await screen.findByRole('complementary', { name: /percy patient/i });
    expect(panel).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('explains a failed detail fetch and offers a retry, without apologising', async () => {
    const routes = [{ method: 'GET', path: '/admin/patients/r1', status: 404, body: { error: 'not_found' } }];
    stubFetchRoutes(routes);
    render(<PatientsPage data={{ patients }} notify={vi.fn()} />);

    await userEvent.click(screen.getByRole('button', { name: /percy patient/i }));

    const message = await screen.findByText(/couldn't be found/i);
    expect(message.textContent.toLowerCase()).not.toMatch(/sorry|apolog/);

    // Retry re-fetches — swap the stub so this time it succeeds (stubFetchRoutes.find() would
    // otherwise keep matching the original 404 entry first).
    routes.splice(0, routes.length, { method: 'GET', path: '/admin/patients/r1', body: detail });
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByText('ABCD2345')).toBeInTheDocument();
  });

  it('closes via the Close button and returns focus to the row that opened it', async () => {
    stubFetchRoutes([{ method: 'GET', path: '/admin/patients/r1', body: detail }]);
    render(<PatientsPage data={{ patients }} notify={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: /percy patient/i });
    await userEvent.click(trigger);
    await screen.findByText('ABCD2345');

    await userEvent.click(screen.getByRole('button', { name: /close/i }));
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
