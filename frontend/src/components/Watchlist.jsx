import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { apiRequest } from '../api';
import { SUPPORTED_SYMBOLS } from '../config';

export default function Watchlist({ watchedSymbols, onSymbolAdded, onSymbolRemoved }) {
  const { token } = useAuth();
  const [selected, setSelected] = useState(SUPPORTED_SYMBOLS[0]);
  const [status, setStatus] = useState(null);
  const [removingSymbol, setRemovingSymbol] = useState(null);

  const handleAdd = async (e) => {
    e.preventDefault();
    setStatus(null);
    try {
      await apiRequest('/api/watchlist', token, {
        method: 'POST',
        body: JSON.stringify({ asset_symbol: selected }),
      });
      setStatus({ type: 'success', message: `${selected} added to watchlist.` });
      onSymbolAdded(selected);
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    }
  };

  const handleRemove = async (symbol) => {
    setStatus(null);
    setRemovingSymbol(symbol);
    try {
      await apiRequest(`/api/watchlist/${symbol}`, token, { method: 'DELETE' });
      setStatus({ type: 'success', message: `${symbol} removed from watchlist.`, className: 'mb-4' });
      onSymbolRemoved(symbol);
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    } finally {
      setRemovingSymbol(null);
    }
  };

  return (
    <div className="card">
      <h3>Watchlist</h3>
      <form onSubmit={handleAdd} className="inline-form">
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {SUPPORTED_SYMBOLS.map((sym) => (
            <option key={sym} value={sym}>{sym}</option>
          ))}
        </select>
        <button type="submit">Add to watchlist</button>
      </form>
      {status && (
        <p className={status.type === 'error' ? 'error-text' : 'success-text mb-4'}>{status.message}</p>
      )}

      <div className="chip-row">
        {watchedSymbols.length === 0 ? (
          <span className="muted">No symbols watched yet.</span>
        ) : (
          watchedSymbols.map((sym) => (
            <span key={sym} className="chip">
              {sym}
              <button
                type="button"
                className="chip-remove"
                onClick={() => handleRemove(sym)}
                disabled={removingSymbol === sym}
                aria-label={`Remove ${sym} from watchlist`}
                title={`Remove ${sym}`}
              >
                {removingSymbol === sym ? '…' : '×'}
              </button>
            </span>
          ))
        )}
      </div>
    </div>
  );
}