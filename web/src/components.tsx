import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, description, action }: {
  eyebrow: string;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="page-heading heading-row">
      <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p className="muted">{description}</p></div>
      {action}
    </div>
  );
}

export function Panel({ title, eyebrow, action, children, className = "" }: {
  title: string;
  eyebrow?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel business-panel ${className}`}>
      <div className="panel-header">
        <div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ErrorNotice({ error }: { error: string }) {
  return error ? <div className="notice notice-error">{error}</div> : null;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="empty-state"><span>◇</span><b>{children}</b></div>;
}

export function DataTable({ columns, rows, emptyText = "暂无数据", onRowClick }: {
  columns: Array<{ key: string; label: string; render?: (row: Record<string, unknown>) => ReactNode }>;
  rows: Array<Record<string, unknown>>;
  emptyText?: string;
  onRowClick?: (row: Record<string, unknown>) => void;
}) {
  if (!rows.length) return <EmptyState>{emptyText}</EmptyState>;
  return (
    <div className="table-scroll">
      <table><thead><tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
        <tbody>{rows.map((row, index) => (
          <tr key={String(row.id ?? row.event_id ?? row.reference ?? index)} onClick={() => onRowClick?.(row)}>
            {columns.map((column) => <td key={column.key}>{column.render ? column.render(row) : toText(row[column.key])}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function toText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
