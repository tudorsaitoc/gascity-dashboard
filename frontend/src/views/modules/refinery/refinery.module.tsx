// Refinery view descriptor — saitoc first-party module, opt-in via
// MODULES_ENABLED=refinery. Nav order 55 seats the merge pipeline between
// Mail (50) and Health (60): it reads as part of the work plane, not the
// diagnostics plane.

import { lazy } from 'react';
import type { FrontendViewDescriptor } from '../../types.js';

export const refineryView: FrontendViewDescriptor = {
  id: 'refinery',
  kind: 'firstParty',
  path: '/refinery',
  nav: { label: 'Refinery', order: 55 },
  element: lazy(() => import('./Refinery').then((m) => ({ default: m.RefineryPage }))),
};
