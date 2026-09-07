import { useEffect, useRef, useState, type ReactNode } from 'react';
import { appStore, runSearch, selectResult, useStore } from '../app/state';

export default function SearchPanel(): ReactNode {
  const s = useStore(appStore);
  const [text, setText] = useState(s.search.text);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (s.panel === 'search') inputRef.current?.focus();
  }, [s.panel]);

  const submit = (): void => {
    if (text.trim().length > 1) void runSearch(text.trim());
  };

  return (
    <div className="sheet search-sheet">
      <div className="sheet-handle" />
      <div className="search-row">
        <input
          ref={inputRef}
          value={text}
          placeholder="Where to?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button className="primary" onClick={submit} disabled={s.search.busy}>
          {s.search.busy ? '…' : 'Go'}
        </button>
      </div>
      <div className="search-hint">
        {s.net === 'online'
          ? 'Searching online + your offline cache.'
          : s.search.results.length > 0
            ? 'Offline — searching your cached map areas.'
            : 'Offline — only areas you have cached are searchable.'}
      </div>
      {s.search.degraded && (
        <div className="search-hint warn">Online search unavailable — showing cached results only.</div>
      )}
      <div className="results">
        {s.search.results.map((r) => (
          <button key={r.id} className="result" onClick={() => selectResult(r)}>
            <div className="result-main">
              <span className="result-name">{r.name}</span>
              {r.detail && <span className="result-detail">{r.detail}</span>}
            </div>
            <span className={`badge ${r.source === 'local' ? 'badge-local' : 'badge-online'}`}>
              {r.source === 'local' ? 'offline cache' : 'online'}
            </span>
          </button>
        ))}
        {s.search.searched && s.search.results.length === 0 && !s.search.busy && (
          <div className="empty">
            No matches. {s.net !== 'online' && 'Destinations outside your cached areas need connectivity the first time.'}
          </div>
        )}
      </div>
    </div>
  );
}
