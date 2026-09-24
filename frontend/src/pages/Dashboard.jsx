import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import PriceTicker from '../components/PriceTicker';
import Watchlist from '../components/Watchlist';
import Alerts from '../components/Alerts';
import { SUPPORTED_SYMBOLS } from '../config';

export default function Dashboard() {
  const { email, logout } = useAuth();
  // Start with a couple of default tickers; grows as the user adds to their watchlist.
  const [tickerSymbols, setTickerSymbols] = useState(['BTC', 'ETH']);

  const handleSymbolAdded = (symbol) => {
    setTickerSymbols((prev) => (prev.includes(symbol) ? prev : [...prev, symbol]));
  };

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <h1>Financial Data Aggregator</h1>
        <div className="header-right">
          <span className="muted">{email}</span>
          <button onClick={logout} className="secondary-btn">Log Out</button>
        </div>
      </header>

      <section className="ticker-grid">
        {tickerSymbols.map((symbol) => (
          <PriceTicker key={symbol} symbol={symbol} />
        ))}
      </section>

      <section className="panels">
        <Watchlist watchedSymbols={tickerSymbols} onSymbolAdded={handleSymbolAdded} />
        <Alerts />
      </section>
    </div>
  );
}
