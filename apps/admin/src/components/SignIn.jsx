import { useState } from 'react';
import { sendOtp, verifyOtp } from '../api/auth.js';

export default function SignIn({ onSignedIn }) {
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState(false);
  const [devHint, setDevHint] = useState(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);

  const send = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const out = await sendOtp(phone);
      setSent(true);
      setDevHint(out.devHint ?? null);
    } catch (err) {
      setError(err.code ?? 'send_failed');
    }
  };

  const verify = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      onSignedIn(await verifyOtp(phone, code));
    } catch (err) {
      setError(err.code ?? 'verify_failed');
    }
  };

  return (
    <div className="signin">
      <div className="signin-card">
        <p className="wordmark">GM Dental</p>
        <h1>Referral Admin</h1>
        <form onSubmit={send}>
          <label htmlFor="signin-phone">Mobile number</label>
          <input
            id="signin-phone"
            type="tel"
            autoComplete="tel"
            placeholder="07700 900123"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <button type="submit">{sent ? 'Resend code' : 'Send code'}</button>
        </form>
        {sent && (
          <form onSubmit={verify}>
            <label htmlFor="signin-code">6-digit code</label>
            <input
              id="signin-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button type="submit">Sign in</button>
          </form>
        )}
        {devHint && <p className="devhint">{devHint}</p>}
        {error && <p role="alert" className="error">{error}</p>}
      </div>
    </div>
  );
}
