import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// findBy*/waitFor default to a 1s budget. A cold jsdom environment on a loaded machine can
// blow through that on the first render of a suite and fail a test that is merely slow, not
// broken — the classic source of "green locally, flaky in CI".
configure({ asyncUtilTimeout: 5000 });

afterEach(cleanup);
