import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'

// Testing Library only auto-cleans when the test globals are on; we keep them
// off, so unmount between tests by hand.
afterEach(() => cleanup())
