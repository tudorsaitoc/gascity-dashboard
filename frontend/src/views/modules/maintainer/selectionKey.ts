export interface SelectionKey {
  readonly kind: 'pr' | 'issue';
  readonly number: number;
}

export function selectionKey(item: SelectionKey): string {
  return `${item.kind}:${item.number}`;
}
