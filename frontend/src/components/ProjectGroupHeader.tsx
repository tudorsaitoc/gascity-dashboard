// ProjectGroupHeader: a typeset section divider, clickable to toggle
// collapse. The chevron is a glyph (▸ collapsed, ▾ expanded), not a
// box. The count badge is plain tabular figures in fg-faint, not a
// pill. Whitespace + type carries the hierarchy (Flat Page Rule).

interface ProjectGroupHeaderProps {
  project: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
}

export function ProjectGroupHeader({
  project,
  count,
  collapsed,
  onToggle,
}: ProjectGroupHeaderProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      className="group flex items-baseline gap-2 w-full text-left focus-mark rounded-sm py-1"
    >
      <span
        aria-hidden
        className="text-fg-faint group-hover:text-fg-muted tnum w-3"
      >
        {collapsed ? '▸' : '▾'}
      </span>
      <span className="text-title font-medium text-fg group-hover:text-fg">
        {project}
      </span>
      <span className="text-label uppercase tracking-wider text-fg-faint tnum">
        {count}
      </span>
    </button>
  );
}
