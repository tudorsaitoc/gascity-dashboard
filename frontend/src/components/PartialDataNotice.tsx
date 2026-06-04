interface PartialDataNoticeProps {
  label: string;
  title: string;
  show?: boolean;
}

export function PartialDataNotice({ label, title, show = true }: PartialDataNoticeProps) {
  if (!show) return null;

  return (
    <span className="normal-case text-body text-warn" role="status" title={title}>
      {label}
    </span>
  );
}
