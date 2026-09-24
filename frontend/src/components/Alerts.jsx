import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { apiRequest } from '../api';
import { SUPPORTED_SYMBOLS } from '../config';

export default function Alerts() {
  const { token } = useAuth();
  const [alerts, setAlerts] = useState([]);
  const [symbol, setSymbol] = useState(SUPPORTED_SYMBOLS[0]);
  const [targetPrice, setTargetPrice] = useState('');
  const [direction, setDirection] = useState('above');
  const [status, setStatus] = useState(null);

  const loadAlerts = useCallback(async () => {
    try {
      const data = await apiRequest('/api/alerts', token);
      setAlerts(data.alerts || []);
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    }
  }, [token]);

  useEffect(() => {
    loadAlerts();
  }, [loadAlerts]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setStatus(null);
    if (!targetPrice) {
      setStatus({ type: 'error', message: 'Enter a target price.' });
      return;
    }
    try {
      await apiRequest('/api/alerts', token, {
        method: 'POST',
        body: JSON.stringify({ asset_symbol: symbol, target_price: Number(targetPrice), direction }),
      });
      setStatus({ type: 'success', message: 'Alert created.' });
      setTargetPrice('');
      loadAlerts();
    } catch (err) {
      setStatus({ type: 'error', message: err.message });
    }
  };

  return (
    <div className="card">
      <h3>Price Alerts</h3>
      <form onSubmit={handleCreate} className="alert-form">
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
          {SUPPORTED_SYMBOLS.map((sym) => (
            <option key={sym} value={sym}>{sym}</option>
          ))}
        </select>
        <select value={direction} onChange={(e) => setDirection(e.target.value)}>
          <option value="above">goes above</option>
          <option value="below">goes below</option>
        </select>
        <input
          type="number"
          placeholder="Target price (₹)"
          value={targetPrice}
          onChange={(e) => setTargetPrice(e.target.value)}
        />
        <button type="submit">Create Alert</button>
      </form>
      {status && (
        <p className={status.type === 'error' ? 'error-text' : 'success-text'}>{status.message}</p>
      )}

      <table className="alerts-table">
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Condition</th>
            <th>Status</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {alerts.length === 0 ? (
            <tr><td colSpan={4} className="muted">No alerts yet.</td></tr>
          ) : (
            alerts.map((a) => (
              <tr key={a.id}>
                <td>{a.asset_symbol}</td>
                <td>{a.direction} ₹{Number(a.target_price).toLocaleString('en-IN')}</td>
                <td>{a.is_active ? 'Active' : 'Triggered'}</td>
                <td>{new Date(a.created_at).toLocaleString()}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
