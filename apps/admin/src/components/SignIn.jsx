import { useState } from 'react';
import { signIn } from '../api/auth.js';
import { errorMessage } from '../copy.js';

export default function SignIn({ onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      onSignedIn(await signIn(email, password));
    } catch (err) {
      setError(err.code ?? 'sign_in_failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="signin">
      <div className="signin-card">
        <p className="wordmark">GM Dental</p>
        <h1>Referral Admin</h1>
        <form onSubmit={submit}>
          <label htmlFor="signin-email">Email</label>
          <input
            id="signin-email"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <label htmlFor="signin-password">Password</label>
          <input
            id="signin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button type="submit" disabled={submitting}>Sign in</button>
        </form>
        {error && <p role="alert" className="error">{errorMessage(error)}</p>}
      </div>
    </div>
  );
}
