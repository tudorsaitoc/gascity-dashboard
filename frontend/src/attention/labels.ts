import type { AttentionDomain } from './compose';

const DOMAIN_LABELS: Record<AttentionDomain, string> = {
  agents: 'Agents',
  beads: 'Beads',
  runs: 'Runs',
  mail: 'Mail',
  activity: 'Activity',
  health: 'Health',
  maintainer: 'Maintainer',
};

export function attentionDomainLabel(domain: AttentionDomain): string {
  return DOMAIN_LABELS[domain];
}
