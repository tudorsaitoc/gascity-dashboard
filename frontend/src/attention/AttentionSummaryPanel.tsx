import { useAttentionModel } from './context';
import { attentionDomainLabel } from './labels';
import type { AttentionItem, AttentionSeverity } from './compose';

export function AttentionSummaryPanel() {
  const attention = useAttentionModel();
  if (attention.items.length === 0) return null;

  return (
    <section aria-labelledby="attention-summary-title" className="space-y-3">
      <h2 id="attention-summary-title" className="text-headline font-semibold text-fg">
        Attention
      </h2>
      <ul className="space-y-2">
        {attention.topItems.map((item) => (
          <li key={`${item.domain}:${item.id}`} className="text-body text-fg flex items-baseline gap-3">
            <AttentionTitle item={item} />
            <span className={`text-label uppercase tracking-wider ${severityClass(item.severity)}`}>
              {attentionDomainLabel(item.domain)}
            </span>
          </li>
        ))}
      </ul>
      {attention.overflowByDomain.length > 0 && (
        <p className="text-label uppercase tracking-wider text-fg-muted">
          {attention.overflowByDomain
            .map((group) => `${group.total} more in ${attentionDomainLabel(group.domain)}`)
            .join(' · ')}
        </p>
      )}
    </section>
  );
}

function AttentionTitle({ item }: { item: AttentionItem }) {
  if (item.href === undefined) {
    return <span className="font-medium">{item.title}</span>;
  }
  return (
    <a href={item.href} className="font-medium hover:text-fg focus-mark">
      {item.title}
    </a>
  );
}

function severityClass(severity: AttentionSeverity): string {
  return severity === 'attention' ? 'text-accent' : 'text-warn';
}
