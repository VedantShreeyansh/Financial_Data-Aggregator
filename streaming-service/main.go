package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

// Configure the WebSocket Upgrader
var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type PriceTicker struct {
	Symbol    string    `json:"symbol"`
	PriceINR  string    `json:"price_inr"`
	Timestamp time.Time `json:"timestamp"`
	Source    string    `json:"source"`
}

// Mirrors the COINGECKO_ID_MAP keys in server.js — keep these two lists
// in sync whenever you add support for a new asset on the Node side.
var validSymbols = map[string]bool{
	"BTC":   true,
	"ETH":   true,
	"SOL":   true,
	"XRP":   true,
	"DOGE":  true,
	"ADA":   true,
	"MATIC": true,
	"LTC":   true,
}

const (
	pongWait   = 60 * time.Second
	pingPeriod = (pongWait * 9) / 10 // send pings a bit before the pong deadline expires
)

// Go uses contexts to handle async timeouts/deadlines
var ctx = context.Background()
var rdb *redis.Client

func main() {
	rdb = redis.NewClient(&redis.Options{
		Addr: "127.0.0.1:6379",
	})

	_, err := rdb.Ping(ctx).Result()
	if err != nil {
		fmt.Println("❌ Go failed to connect to Redis cache database server:", err)
		return
	}
	fmt.Println("✅ Go Microservice linked successfully to Redis RAM Layer.")

	http.HandleFunc("/ws/prices/", func(w http.ResponseWriter, r *http.Request) {
		symbol := strings.TrimPrefix(r.URL.Path, "/ws/prices/")
		symbol = strings.ToUpper(strings.TrimSpace(symbol))

		if symbol == "" {
			http.Error(w, "Symbol is required, e.g. /ws/prices/BTC", http.StatusBadRequest)
			return
		}

		// FIXED: reject unsupported symbols before upgrading the connection,
		// instead of silently polling a Redis key that will never exist.
		if !validSymbols[symbol] {
			http.Error(w, fmt.Sprintf("Unsupported symbol: %s", symbol), http.StatusBadRequest)
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			fmt.Println("❌ WebSocket Upgrade Failed:", err)
			return
		}
		defer conn.Close()
		fmt.Printf("🔌 A client connected to the Live Go Stream for %s!\n", symbol)

		// FIXED: proactively detect dead/disconnected clients instead of only
		// finding out on the next failed WriteMessage call. A dedicated reader
		// goroutine watches for close frames and pong replies; disconnected
		// signals the writer loop below to stop immediately.
		disconnected := make(chan struct{})
		conn.SetReadDeadline(time.Now().Add(pongWait))
		conn.SetPongHandler(func(string) error {
			conn.SetReadDeadline(time.Now().Add(pongWait))
			return nil
		})
		go func() {
			defer close(disconnected)
			for {
				if _, _, err := conn.ReadMessage(); err != nil {
					return
				}
			}
		}()

		pingTicker := time.NewTicker(pingPeriod)
		defer pingTicker.Stop()

		dataTicker := time.NewTicker(2 * time.Second)
		defer dataTicker.Stop()

	streamLoop:
		for {
			select {
			case <-disconnected:
				fmt.Printf("🔌 Client for %s disconnected.\n", symbol)
				break streamLoop

			case <-pingTicker.C:
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					fmt.Println("❌ Ping failed, closing connection:", err)
					break streamLoop
				}

			case <-dataTicker.C:
				cachedVal, err := rdb.Get(ctx, symbol).Result()
				var price string
				var dataSource string

				if err == redis.Nil {
					price = "Waiting for Node.js update..."
					dataSource = "Cache Empty"
				} else if err != nil {
					fmt.Println("❌ Error fetching from Redis:", err)
					break streamLoop
				} else {
					price = cachedVal
					dataSource = "Live Redis Cache Pipeline"
				}

				tickerData := PriceTicker{
					Symbol:    symbol,
					PriceINR:  price,
					Timestamp: time.Now(),
					Source:    dataSource,
				}

				payload, err := json.Marshal(tickerData)
				if err != nil {
					fmt.Println("❌ Failed to marshal ticker data:", err)
					break streamLoop
				}

				if err := conn.WriteMessage(websocket.TextMessage, payload); err != nil {
					fmt.Println("🔌 Client disconnected:", err)
					break streamLoop
				}
			}
		}
	})

	// FIXED: binding to just ":9090" was resulting in an IPv6-only listener
	// inside WSL2, and WSL's port-forwarding relay (wslrelay.exe) only
	// mirrored the IPv6 side to Windows — so 127.0.0.1:9090 (IPv4, what
	// browsers and Test-NetConnection default to) was never reachable from
	// the Windows side. Binding explicitly to 0.0.0.0 forces an IPv4 listener.
	fmt.Println("🚀 Go WebSocket server listening on 0.0.0.0:9090")
	if err := http.ListenAndServe("0.0.0.0:9090", nil); err != nil {
		fmt.Println("❌ CRITICAL BOOT ERROR:", err)
	}
}