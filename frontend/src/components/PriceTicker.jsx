import { useEffect, useRef, useState } from 'react';
import { WS_BASE_URL, API_BASE_URL } from '../config';

// How often to proactively ask server.js to refresh this symbol's price.
// Set comfortably under Redis's 60s cache TTL so the cache never fully
// goes cold between refreshes.
const REFRESH_INTERVAL_MS = 45_000;

// Connects to main.go's dynamic /ws/prices/:symbol route and renders
// whatever it streams, reconnecting automatically if the connection drops.
// Also proactively refreshes the underlying price on an interval, since
// nothing else in the system does this for symbols that are only being
// *displayed* (as opposed to symbols with an active price alert, which
// worker.js already keeps warm on its own).
export default function PriceTicker({ symbol }) {
  const [tick, setTick] = useState(null);
  const [status, setStatus] = useState('connecting');
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);

  useEffect(() => {
    let cancelled = false;

    function connect() {
      const ws = new WebSocket(`${WS_BASE_URL}/ws/prices/${symbol}`);
      wsRef.current = ws;
      setStatus('connecting');

      ws.onopen = () => {
        if (!cancelled) setStatus('connected');
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          setTick(JSON.parse(event.data));
        } catch {
          // ignore malformed frames
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setStatus('disconnected');
        // Simple auto-reconnect after a short delay.
        reconnectTimeoutRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimeoutRef.current);
      wsRef.current?.close();
    };
  }, [symbol]);

  // Proactive cache refresh: fire an immediate fetch on mount, then repeat
  // on an interval. This is what makes the ticker self-sufficient — no
  // Postman, no manual curl, no dependency on an alert existing for this
  // symbol.
  useEffect(() => {
    let cancelled = false;

    async function refreshPrice() {
      try {
        await fetch(`${API_BASE_URL}/api/prices/${symbol}`);
      } catch {
        // Transient network/API errors are fine — the next interval tick
        // will simply try again. No need to surface this to the user.
      }
    }

    refreshPrice();
    const intervalId = setInterval(() => {
      if (!cancelled) refreshPrice();
    }, REFRESH_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [symbol]);

  const isLive = tick?.source === 'Live Redis Cache Pipeline';

  return (
    <div className="price-ticker">
      <div className="price-ticker-header">
        <span className="symbol">{symbol}</span>
        <span className={`status-dot status-${status}`} title={status} />
      </div>
      {tick ? (
        <>
          <div className="price">
            {typeof tick.price_inr === 'number' || !isNaN(parseFloat(tick.price_inr))
              ? `₹${parseFloat(tick.price_inr).toLocaleString('en-IN')}`
              : tick.price_inr}
          </div>
          <div className={`source ${isLive ? 'source-live' : 'source-waiting'}`}>
            {isLive ? 'Live' : 'Waiting for price data…'}
          </div>
        </>
      ) : (
        <div className="price price-loading">…</div>
      )}
    </div>
  );
}