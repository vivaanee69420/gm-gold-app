import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup, configure } from '@testing-library/react';

// Same budget as apps/admin: a cold jsdom environment on a loaded machine can blow through
// the 1s default on a suite's first render and fail a test that is merely slow, not broken.
configure({ asyncUtilTimeout: 5000 });

afterEach(cleanup);
