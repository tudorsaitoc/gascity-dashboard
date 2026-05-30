// Maintainer (Triage) frontend view descriptor — firstParty, opt-in via
// the backend's enabledModules in PR-C. PR-B2 wires this into ALL_VIEWS
// so App.tsx + Header.tsx no longer mention /maintainer explicitly.
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
