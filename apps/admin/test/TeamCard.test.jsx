import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamCard from '../src/components/TeamCard.jsx';
import { clearToken, setToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

const practices = [{ id: 'pr-sidcup', name: 'Sidcup' }, { id: 'pr-ashford', name: 'Ashford' }];

const team = [
  {
    id: 'ad-1',
    email: 'owner@gmdental.co.uk',
    role: 'admin',
    practices: [{ id: 'pr-sidcup', name: 'Sidcup' }, { id: 'pr-ashford', name: 'Ashford' }],
    active: true,
    lastLoginAt: '2026-08-27T10:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
  },
  {
    id: 'ad-2',
    email: 'manager@gmdental.co.uk',
    role: 'manager',
    practices: [{ id: 'pr-sidcup', name: 'Sidcup' }],
    active: false,
    lastLoginAt: null,
    createdAt: '2026-02-01T00:00:00.000Z',
  },
];

beforeEach(() => {
  clearToken();
  setToken('tok');
});
afterEach(() => vi.unstubAllGlobals());

describe('TeamCard', () => {
  it('lists team rows with email, role, practice, active state, and last login', async () => {
    stubFetchRoutes([{ method: 'GET', path: '/admin/team', body: { team } }]);
    render(<TeamCard practices={practices} notify={vi.fn()} />);

    const ownerRow = (await screen.findByText('owner@gmdental.co.uk')).closest('tr');
    expect(ownerRow).toHaveTextContent('admin');
    expect(ownerRow).toHaveTextContent('Sidcup, Ashford');
    expect(ownerRow).toHaveTextContent('Active');

    const managerRow = screen.getByText('manager@gmdental.co.uk').closest('tr');
    expect(managerRow).toHaveTextContent('manager');
    expect(managerRow).toHaveTextContent('Sidcup');
    expect(managerRow).toHaveTextContent('Inactive');
  });

  it('creating a manager account sends practiceId', async () => {
    const calls = stubFetchRoutes([
      { method: 'GET', path: '/admin/team', body: { team: [] } },
      { method: 'POST', path: '/admin/team', body: { admin: { id: 'ad-3' } } },
    ]);
    render(<TeamCard practices={practices} notify={vi.fn()} />);
    await screen.findByRole('button', { name: /add account/i });

    await userEvent.type(screen.getByLabelText(/^email$/i), 'newmanager@gmdental.co.uk');
    await userEvent.type(screen.getByLabelText(/temporary password/i), 'correcthorsebattery');
    await userEvent.selectOptions(screen.getByLabelText(/role/i), 'manager');
    await userEvent.selectOptions(screen.getByLabelText(/practice/i), 'pr-ashford');
    await userEvent.click(screen.getByRole('button', { name: /add account/i }));

    const posted = calls.find((c) => c.method === 'POST' && c.path === '/admin/team');
    expect(posted.body).toEqual({
      email: 'newmanager@gmdental.co.uk',
      password: 'correcthorsebattery',
      role: 'manager',
      practiceId: 'pr-ashford',
    });
  });

  it('creating an admin account does not send a practiceId', async () => {
    const calls = stubFetchRoutes([
      { method: 'GET', path: '/admin/team', body: { team: [] } },
      { method: 'POST', path: '/admin/team', body: { admin: { id: 'ad-4' } } },
    ]);
    render(<TeamCard practices={practices} notify={vi.fn()} />);
    await screen.findByRole('button', { name: /add account/i });

    await userEvent.type(screen.getByLabelText(/^email$/i), 'newadmin@gmdental.co.uk');
    await userEvent.type(screen.getByLabelText(/temporary password/i), 'correcthorsebattery');
    await userEvent.selectOptions(screen.getByLabelText(/role/i), 'admin');
    await userEvent.click(screen.getByRole('button', { name: /add account/i }));

    const posted = calls.find((c) => c.method === 'POST' && c.path === '/admin/team');
    expect(posted.body).toEqual({
      email: 'newadmin@gmdental.co.uk',
      password: 'correcthorsebattery',
      role: 'admin',
    });
  });

  it('sets a new password for a row', async () => {
    const calls = stubFetchRoutes([
      { method: 'GET', path: '/admin/team', body: { team } },
      { method: 'POST', path: '/admin/team/ad-2/password', body: { ok: true } },
    ]);
    render(<TeamCard practices={practices} notify={vi.fn()} />);
    const managerRow = within((await screen.findByText('manager@gmdental.co.uk')).closest('tr'));

    await userEvent.type(managerRow.getByLabelText(/new password/i), 'anothersafepassword');
    await userEvent.click(managerRow.getByRole('button', { name: /save/i }));

    const posted = calls.find((c) => c.method === 'POST' && c.path === '/admin/team/ad-2/password');
    expect(posted.body).toEqual({ password: 'anothersafepassword' });
  });

  it('deactivates an active row', async () => {
    const calls = stubFetchRoutes([
      { method: 'GET', path: '/admin/team', body: { team } },
      { method: 'POST', path: '/admin/team/ad-1/active', body: { ok: true } },
    ]);
    render(<TeamCard practices={practices} notify={vi.fn()} />);
    const ownerRow = within((await screen.findByText('owner@gmdental.co.uk')).closest('tr'));

    await userEvent.click(ownerRow.getByRole('button', { name: /deactivate/i }));

    const posted = calls.find((c) => c.method === 'POST' && c.path === '/admin/team/ad-1/active');
    expect(posted.body).toEqual({ active: false });
  });

  it('reactivates an inactive row', async () => {
    const calls = stubFetchRoutes([
      { method: 'GET', path: '/admin/team', body: { team } },
      { method: 'POST', path: '/admin/team/ad-2/active', body: { ok: true } },
    ]);
    render(<TeamCard practices={practices} notify={vi.fn()} />);
    const managerRow = within((await screen.findByText('manager@gmdental.co.uk')).closest('tr'));

    await userEvent.click(managerRow.getByRole('button', { name: /reactivate/i }));

    const posted = calls.find((c) => c.method === 'POST' && c.path === '/admin/team/ad-2/active');
    expect(posted.body).toEqual({ active: true });
  });

  it('notifies with the error code when deactivating fails', async () => {
    stubFetchRoutes([
      { method: 'GET', path: '/admin/team', body: { team } },
      { method: 'POST', path: '/admin/team/ad-1/active', body: { error: 'last_admin' }, status: 409 },
    ]);
    const notify = vi.fn();
    render(<TeamCard practices={practices} notify={notify} />);
    const ownerRow = within((await screen.findByText('owner@gmdental.co.uk')).closest('tr'));

    await userEvent.click(ownerRow.getByRole('button', { name: /deactivate/i }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('last_admin'));
  });

  it('notifies with the error code when creating an account fails', async () => {
    stubFetchRoutes([
      { method: 'GET', path: '/admin/team', body: { team: [] } },
      { method: 'POST', path: '/admin/team', body: { error: 'email_taken' }, status: 409 },
    ]);
    const notify = vi.fn();
    render(<TeamCard practices={practices} notify={notify} />);
    await screen.findByRole('button', { name: /add account/i });

    await userEvent.type(screen.getByLabelText(/^email$/i), 'dupe@gmdental.co.uk');
    await userEvent.type(screen.getByLabelText(/temporary password/i), 'correcthorsebattery');
    await userEvent.selectOptions(screen.getByLabelText(/role/i), 'admin');
    await userEvent.click(screen.getByRole('button', { name: /add account/i }));

    await vi.waitFor(() => expect(notify).toHaveBeenCalledWith('email_taken'));
  });
});
