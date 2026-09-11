// "I was referred" used to be a one-way door. EnterCode is the first screen of its stack, so
// goBack() did nothing, and the role picker lived only in the no-roles navigator — unreachable
// once a role existed. Someone who tapped the wrong role was stuck on this screen for good.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';

const navigation = { navigate: vi.fn(), reset: vi.fn(), replace: vi.fn() };
const referredStatus = vi.fn();

vi.mock('../src/api/client', () => ({
  api: { referredStatus: () => referredStatus() },
  isMockMode: () => false,
}));

vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (cb) => useEffect(() => cb(), []),
}));

// referred.js exports three screens and imports what all of them need. expo-camera is on this
// screen but useless under jsdom; BookAppointment and AppState belong to the later ones.
vi.mock('expo-camera', () => ({
  CameraView: () => null,
  useCameraPermissions: () => [{ granted: false }, vi.fn()],
}));
vi.mock('../src/components/BookAppointment', () => ({ default: () => null }));
vi.mock('../src/state/AppState', () => ({ useAppState: () => ({ user: null }) }));

const { EnterCodeScreen } = await import('../src/screens/referred');

const show = async () => {
  // No live referral: the screen stays put rather than resetting to ReferredStatus.
  referredStatus.mockResolvedValue(null);
  await act(async () => {
    render(<EnterCodeScreen navigation={navigation} />);
  });
};

beforeEach(() => {
  navigation.navigate.mockReset();
  navigation.reset.mockReset();
  referredStatus.mockReset();
});

describe('EnterCodeScreen escape route', () => {
  it('offers a way back off the screen', async () => {
    await show();
    expect(screen.getByText(/not what you meant/i)).toBeInTheDocument();
  });

  it('sends them to the role picker, not into a dead goBack()', async () => {
    await show();
    fireEvent.click(screen.getByText(/not what you meant/i));
    expect(navigation.navigate).toHaveBeenCalledWith('RolePicker');
  });
});

describe('EnterCodeScreen code entry', () => {
  it('accepts a name-and-suffix code and carries it forward', async () => {
    await show();
    fireEvent.change(screen.getByPlaceholderText('SARAH-7K2X'), { target: { value: 'sarah-7k2x' } });
    fireEvent.click(screen.getByText('Continue'));

    // Normalized on the way through: uppercased, hyphen stripped.
    expect(navigation.navigate).toHaveBeenCalledWith('BookingForm', { code: 'SARAH7K2X' });
  });

  it('accepts a short name', async () => {
    await show();
    fireEvent.change(screen.getByPlaceholderText('SARAH-7K2X'), { target: { value: 'JO-7K2X' } });
    fireEvent.click(screen.getByText('Continue'));
    expect(navigation.navigate).toHaveBeenCalledWith('BookingForm', { code: 'JO7K2X' });
  });

  it('describes the shape without naming a length', async () => {
    // A code is a first name plus four characters, so "8 letters and numbers" was wrong for
    // every code the app now issues.
    await show();
    fireEvent.change(screen.getByPlaceholderText('SARAH-7K2X'), { target: { value: 'nope!' } });
    fireEvent.click(screen.getByText('Continue'));

    expect(screen.getByText(/friend’s name and a few characters/i)).toBeInTheDocument();
    expect(screen.queryByText(/8 letters/i)).not.toBeInTheDocument();
    expect(navigation.navigate).not.toHaveBeenCalledWith('BookingForm', expect.anything());
  });

  it('still strips the QR deep-link prefix', async () => {
    await show();
    fireEvent.change(screen.getByPlaceholderText('SARAH-7K2X'), {
      target: { value: 'gmreferral://r/SARAH7K2X' },
    });
    fireEvent.click(screen.getByText('Continue'));
    expect(navigation.navigate).toHaveBeenCalledWith('BookingForm', { code: 'SARAH7K2X' });
  });
});
