import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import TeamList from '../src/components/team/TeamList.jsx';
import TeamMember from '../src/components/team/TeamMember.jsx';
import AddUser from '../src/components/team/AddUser.jsx';
import { clearToken, getToken, setToken } from '../src/api/client.js';
import { stubFetchRoutes } from './helpers.js';

const practices = [
  { id: 'p1', name: 'Ashford' },
  { id: 'p2', name: 'Barnet' },
];

const owner = {
  id: 'a1', email: 'owner@gmdental.co.uk', name: 'Ada Owner', phone: null,
  role: 'admin', practices: [], pages: ['pipeline', 'patients', 'payouts'],
  active: true, lastLoginAt: null,
};
const manager = {
  id: 'm1', email: 'mo@gmdental.co.uk', name: 'Mo Manager', phone: '07700900123',
  role: 'manager', practices: [practices[0]], pages: ['pipeline'],
  active: true, lastLoginAt: null,
};

beforeEach(() => {
  clearToken();
  setToken('tok');
});
afterEach(() => vi.unstubAllGlobals());

describe('TeamList', () => {
  const renderList = (props = {}) =>
    render(
      <TeamList
        team={[owner, manager]}
        meId="a1"
        practices={practices}
        busyId={null}
        onOpen={vi.fn()}
        onAdd={vi.fn()}
        onToggleActive={vi.fn()}
        {...props}
      />,
    );

  it('shows who each person is, not just their login', () => {
    renderList();
    expect(screen.getByText('Mo Manager')).toBeInTheDocument();
    expect(screen.getByText('mo@gmdental.co.uk')).toBeInTheDocument();
    expect(screen.getByText('07700900123')).toBeInTheDocument();
    // Scoped to the row: 'Ashford' is also an option in the practice filter above the table.
    const row = screen.getByText('Mo Manager').closest('tr');
    expect(within(row).getByText('Ashford')).toBeInTheDocument();
    // An owner covers every practice by construction — never an empty cell.
    expect(screen.getByText('Every practice')).toBeInTheDocument();
  });

  it('marks the signed-in account and gives it no remove control', () => {
    renderList();
    const mine = screen.getByText('Ada Owner').closest('tr');
    expect(within(mine).getByText(/you/i)).toBeInTheDocument();
    // Deactivating yourself is a 409 the API refuses outright, so the control is not offered.
    expect(within(mine).queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
    expect(within(mine).getByRole('button', { name: /edit/i })).toBeInTheDocument();
  });

  it('filters by name, role and practice, and says how many are left', async () => {
    renderList();
    expect(screen.getByText(/2 people/)).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/search team/i), 'mo@');
    expect(screen.getByText(/1 person/)).toBeInTheDocument();
    expect(screen.queryByText('Ada Owner')).not.toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText(/search team/i));
    await userEvent.selectOptions(screen.getByLabelText(/filter by role/i), 'admin');
    expect(screen.getByText('Ada Owner')).toBeInTheDocument();
    expect(screen.queryByText('Mo Manager')).not.toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText(/filter by role/i), 'all');
    await userEvent.selectOptions(screen.getByLabelText(/filter by practice/i), 'p2');
    expect(screen.getByText(/nobody matches those filters/i)).toBeInTheDocument();
  });

  it('opens a member rather than editing them in the row', async () => {
    const onOpen = vi.fn();
    renderList({ onOpen });
    const row = screen.getByText('Mo Manager').closest('tr');
    await userEvent.click(within(row).getByRole('button', { name: /edit/i }));
    expect(onOpen).toHaveBeenCalledWith('m1');
  });
});

describe('TeamMember', () => {
  const renderMember = (member = manager, props = {}) =>
    render(
      <TeamMember
        member={member}
        practices={practices}
        meId="a1"
        onBack={vi.fn()}
        onChanged={vi.fn()}
        notify={vi.fn()}
        {...props}
      />,
    );

  it('saves the person without touching their sign-in address', async () => {
    const calls = stubFetchRoutes([{ method: 'POST', path: '/admin/team/m1/profile' }]);
    renderMember();

    expect(screen.getByLabelText(/^email$/i)).toHaveAttribute('readonly');
    await userEvent.clear(screen.getByLabelText(/full name/i));
    await userEvent.type(screen.getByLabelText(/full name/i), 'Maureen Manager');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await vi.waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/admin/team/m1/profile',
        body: { name: 'Maureen Manager', phone: '07700900123' },
      }),
    );
  });

  it('will not send a password under ten characters', async () => {
    renderMember();
    await userEvent.type(screen.getByLabelText(/set password/i), 'short');
    expect(screen.getByRole('button', { name: /set password/i })).toBeDisabled();
  });

  it('stores the replacement token when the password change was your own', async () => {
    stubFetchRoutes([{ method: 'POST', path: '/admin/team/a1/password', body: { ok: true, token: 'new-tok' } }]);
    renderMember(owner, { meId: 'a1' });

    await userEvent.type(screen.getByLabelText(/set password/i), 'brandnewpassword1');
    await userEvent.click(screen.getByRole('button', { name: /set password/i }));

    // Setting your own password revokes your own sessions; not storing the new token would
    // 401 you out of the screen you are standing on.
    await vi.waitFor(() => expect(getToken()).toBe('new-tok'));
  });

  it('saves which screens a manager reaches, and says what unticking one does', async () => {
    const calls = stubFetchRoutes([{ method: 'POST', path: '/admin/team/m1/pages' }]);
    renderMember();

    await userEvent.click(screen.getByRole('button', { name: /roles & permissions/i }));
    expect(screen.getByLabelText(/pipeline.*move patients/i)).toBeChecked();
    expect(screen.getByLabelText(/payouts.*mark cash paid/i)).not.toBeChecked();
    expect(screen.getByText(/closes the data behind it, not just the link/i)).toBeInTheDocument();

    await userEvent.click(screen.getByLabelText(/payouts.*mark cash paid/i));
    await userEvent.click(screen.getByRole('button', { name: /save screens/i }));

    await vi.waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/admin/team/m1/pages',
        body: { pages: ['pipeline', 'payouts'] },
      }),
    );
  });

  it('offers an owner no screens to narrow, because they reach every one', async () => {
    renderMember(owner);
    await userEvent.click(screen.getByRole('button', { name: /roles & permissions/i }));
    expect(screen.getByText(/an owner reaches every screen/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save screens/i })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^practice$/i)).toHaveValue('Every practice');
  });

  it('only offers to save a practice once a different one is chosen', async () => {
    renderMember();
    await userEvent.click(screen.getByRole('button', { name: /roles & permissions/i }));
    expect(screen.getByRole('button', { name: /save practice/i })).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText(/^practice$/i), 'p2');
    expect(screen.getByRole('button', { name: /save practice/i })).toBeEnabled();
  });
});

describe('AddUser', () => {
  it('sends a manager with their practice, and names them in a second call', async () => {
    const calls = stubFetchRoutes([
      { method: 'POST', path: '/admin/team', body: { admin: { id: 'new1' } } },
      { method: 'POST', path: '/admin/team/new1/profile' },
    ]);
    render(
      <AddUser practices={practices} onDone={vi.fn()} onCancel={vi.fn()} notify={vi.fn()} />,
    );

    await userEvent.type(screen.getByLabelText(/full name/i), 'New Person');
    await userEvent.type(screen.getByLabelText(/^email$/i), 'new@gmdental.co.uk');
    await userEvent.selectOptions(screen.getByLabelText(/^practice$/i), 'p1');
    await userEvent.type(screen.getByLabelText(/temporary password/i), 'temporarypass1');
    await userEvent.click(screen.getByRole('button', { name: /add account/i }));

    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/admin/team',
      body: { email: 'new@gmdental.co.uk', password: 'temporarypass1', role: 'manager', practiceId: 'p1' },
    });
    expect(calls[1].path).toBe('/admin/team/new1/profile');
  });

  it('never sends a practice for an owner — an admin covers every one', async () => {
    const calls = stubFetchRoutes([{ method: 'POST', path: '/admin/team', body: { admin: { id: 'new2' } } }]);
    render(
      <AddUser practices={practices} onDone={vi.fn()} onCancel={vi.fn()} notify={vi.fn()} />,
    );

    await userEvent.selectOptions(screen.getByLabelText(/^role$/i), 'admin');
    await userEvent.type(screen.getByLabelText(/^email$/i), 'boss@gmdental.co.uk');
    await userEvent.type(screen.getByLabelText(/temporary password/i), 'temporarypass1');
    await userEvent.click(screen.getByRole('button', { name: /add account/i }));

    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0].body).not.toHaveProperty('practiceId');
  });
});
