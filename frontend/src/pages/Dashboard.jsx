import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import PriceTicker from '../components/PriceTicker';
import Watchlist from '../components/Watchlist';
import Alerts from '../components/Alerts';
import { apiRequest } from '../api';

export default function Dashboard() {
  const { email, token, logout } = useAuth();
  // Start empty; populated from the saved watchlist once it loads.
  // Falls back to BTC/ETH defaults only for a brand-new user with no
  // saved watchlist at all, so first-time UX stays the same as before.
  const [tickerSymbols, setTickerSymbols] = useState([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadWatchlist() {
      try {
        const data = await apiRequest('/api/watchlist', token);
        if (cancelled) return;

        if (data.symbols && data.symbols.length > 0) {
          setTickerSymbols(data.symbols);
        } else {
          // No saved watchlist yet (new user) — keep the original default.
          setTickerSymbols(['BTC', 'ETH']);
        }
      } catch {
        // If the fetch fails for any reason, fall back to the same
        // default the dashboard always used, rather than showing nothing.
        if (!cancelled) setTickerSymbols(['BTC', 'ETH']);
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }

    loadWatchlist();
    return () => { cancelled = true; };
  }, [token]);

  const handleSymbolAdded = (symbol) => {
    setTickerSymbols((prev) => (prev.includes(symbol) ? prev : [...prev, symbol]));
  };

  const handleSymbolRemoved = (symbol) => {
    setTickerSymbols((prev) => prev.filter((s) => s !== symbol))
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Financial Data Aggregator</h1>
        <div className="header-right">
          <span className="muted">{email}</span>
          <button onClick={logout} className="secondary-btn">Log Out</button>
        </div>
      </header>

      {loaded && (
        <>
          <section className="ticker-grid">
            {tickerSymbols.map((symbol) => (
              <PriceTicker key={symbol} symbol={symbol} />
            ))}
          </section>

          <section className="panels">
            <Watchlist watchedSymbols={tickerSymbols} onSymbolAdded={handleSymbolAdded} onSymbolRemoved={handleSymbolRemoved}/>
            <Alerts />
          </section>
        </>
      )}
    </div>
  );
}