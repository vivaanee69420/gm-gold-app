// Shared dashboard primitives. Every card and list row renders through these
// so spacing, alignment, and count badges stay consistent as cards are added.

export function Card({ title, count, className, children }) {
  return (
    <section className={className ? `card ${className}` : 'card'}>
      <header className="card-head">
        <h3>{title}</h3>
        {count != null && (
          <span className={count === 0 ? 'count-badge count-badge-zero' : 'count-badge'}>{count}</span>
        )}
      </header>
      {children}
    </section>
  );
}

export function ListRow({ title, value, meta, children }) {
  return (
    <li className="list-row">
      <div className="list-line">
        <strong>{title}</strong>
        {value != null && <span className="amount">{value}</span>}
      </div>
      {meta && <p className="meta">{meta}</p>}
      {children}
    </li>
  );
}

export function Zone({ label, className, children }) {
  return (
    <section className={className}>
      {label && <h2 className="zone-label">{label}</h2>}
      {children}
    </section>
  );
}
