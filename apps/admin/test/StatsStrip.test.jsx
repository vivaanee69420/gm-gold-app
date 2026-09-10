import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import StatsStrip from '../src/components/StatsStrip.jsx';

describe('StatsStrip', () => {
  it('shows the credited total, clearly labelled, when liability is withheld (manager)', () => {
    render(
      <StatsStrip
        stats={{ commissionPennies: 10000, liabilityPennies: null, creditedPennies: 5000, referralCounts: {} }}
      />,
    );

    expect(screen.getByText('Credited (your practice)')).toBeInTheDocument();
    expect(screen.getByText('£50.00')).toBeInTheDocument();
    // A manager must never read a practice figure as if it were the company-wide liability.
    expect(screen.queryByText('Liability')).not.toBeInTheDocument();
  });

  it('shows liability unchanged when it is present (owner)', () => {
    render(
      <StatsStrip
        stats={{ commissionPennies: 2000, liabilityPennies: 46000, creditedPennies: 46000, referralCounts: {} }}
      />,
    );

    expect(screen.getByText('Liability')).toBeInTheDocument();
    expect(screen.getByText('£460.00')).toBeInTheDocument();
    expect(screen.queryByText('Credited (your practice)')).not.toBeInTheDocument();
  });
});
