// Maintainer (Triage) frontend view descriptor — firstParty, opt-in via
// the backend's enabledModules in PR-C. PR-B1 ships the descriptor but
// App.tsx + Header.tsx continue to mount /maintainer explicitly; PR-B2
// swaps to descriptor-driven Routes/nav and deletes the explicit wiring.
//
// Lazy import keeps the Maintainer page's chunk out of the default
// first-paint bundle.

import { lazy } from 'react';
import type { FrontendViewDescriptor } from '../../types';

export const maintainerView: FrontendViewDescriptor = {
  id: 'maintainer',
  kind: 'firstParty',
  path: '/maintainer',
  nav: { label: 'Triage', order: 80 },
  element: lazy(() =>
    import('./Maintainer').then((m) => ({ default: m.MaintainerPage })),
  ),
};
