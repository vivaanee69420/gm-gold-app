// Nav and control glyphs, inline so the shell has no icon dependency and every glyph
// inherits the surrounding colour. One stroke weight, one 24-unit grid, square caps
// avoided — they read as drawn by the same hand as the hairlines everywhere else.

const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
  focusable: false,
};

// Three columns of a stage board, the middle one filled higher — the pipeline as it looks.
export const PipelineIcon = (props) => (
  <svg {...base} {...props}>
    <rect x="3" y="4" width="5" height="16" rx="1.5" />
    <rect x="9.5" y="4" width="5" height="16" rx="1.5" />
    <rect x="16" y="4" width="5" height="16" rx="1.5" />
    <path d="M9.5 12h5" />
  </svg>
);

export const PatientsIcon = (props) => (
  <svg {...base} {...props}>
    <circle cx="9" cy="8" r="3.2" />
    <path d="M2.8 19.5c.6-3.3 3.1-5.2 6.2-5.2s5.6 1.9 6.2 5.2" />
    <path d="M16.2 5.4a3.2 3.2 0 0 1 0 6.2" />
    <path d="M17.4 14.6c2.2.5 3.6 2.2 4 4.9" />
  </svg>
);

export const PayoutsIcon = (props) => (
  <svg {...base} {...props}>
    <rect x="2.5" y="6" width="19" height="12" rx="2" />
    <circle cx="12" cy="12" r="2.6" />
    <path d="M6 9.5v5M18 9.5v5" />
  </svg>
);

export const OperationsIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M3 6h12M3 12h8M3 18h12" />
    <path d="M16.5 11.5 18.5 13.5 22 10" />
  </svg>
);

export const ReportsIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M3 20.5h18" />
    <rect x="4.5" y="12" width="4" height="6" rx="1" />
    <rect x="10" y="7.5" width="4" height="10.5" rx="1" />
    <rect x="15.5" y="4" width="4" height="14" rx="1" />
  </svg>
);

export const LockIcon = (props) => (
  <svg {...base} {...props}>
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" />
    <path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9" />
    <path d="M12 14.5v2" />
  </svg>
);

export const SettingsIcon = (props) => (
  <svg {...base} {...props}>
    {/* Teeth hugging the hub, not rays reaching for the edge — the long-spoke version of
        this reads as a sun. */}
    <circle cx="12" cy="12" r="3.4" />
    <path d="M12 4.6v2.8M12 16.6v2.8M4.6 12h2.8M16.6 12h2.8M6.77 6.77l1.98 1.98M15.25 15.25l1.98 1.98M17.23 6.77l-1.98 1.98M8.75 15.25l-1.98 1.98" />
  </svg>
);

export const RefreshIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M20 12a8 8 0 1 1-2.6-5.9" />
    <path d="M20.5 4v4.2h-4.2" />
  </svg>
);

export const MenuIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M3.5 7h17M3.5 12h17M3.5 17h17" />
  </svg>
);

export const CloseIcon = (props) => (
  <svg {...base} {...props}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const NAV_ICONS = {
  pipeline: PipelineIcon,
  patients: PatientsIcon,
  payouts: PayoutsIcon,
  operations: OperationsIcon,
  reports: ReportsIcon,
  settings: SettingsIcon,
};
