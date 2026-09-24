// worker.js
//
// Phase 4: background worker that checks active price alerts against
// live prices and fires a notification when a condition is met.
//
// This runs as its own process, separate from server.js — that way a
// slow or misbehaving check job never blocks your API's request/response
// cycle. Run it alongside the main server:
//
//   node server.js      (terminal 1)
//   node worker.js       (terminal 2)
//
import "dotenv/config";
import pkg from 'pg';
import { createClient } from 'redis';
import { Queue, Worker } from 'bullmq';
import nodemailer from 'nodemailer';

const { Pool } = pkg;

const pool = new Pool({
    user: process.env.PGUSER || 'postgres',
    host: process.env.PGHOST || '127.0.0.1',
    database: process.env.PGDATABASE || 'financial_db',
    password: process.env.PGPASSWORD,
    port: process.env.PGPORT || 5432,
});

const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379'
});
redisClient.on('error', err => console.error('Redis Client Error (worker)', err));

// BullMQ needs its own connection config (host/port), separate from the
// plain redis client above which is used for the simple cache reads.
const bullConnection = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
};

// --- Email transport ---
// If real SMTP credentials are set in .env, use them. Otherwise, fall back
// to a free Ethereal test account (auto-created on boot) so you can see
// real emails land in a browser inbox with zero setup. Swap in real
// credentials later by setting SMTP_HOST/SMTP_USER/SMTP_PASS in .env —
// no code changes needed.
let mailTransporter;

async function setupMailTransporter() {
    if (process.env.SMTP_HOST) {
        mailTransporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: parseInt(process.env.SMTP_PORT || '587', 10),
            secure: process.env.SMTP_SECURE === 'true',
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS,
            },
        });
        console.log(`📧 Using configured SMTP host: ${process.env.SMTP_HOST}`);
    } else {
        const testAccount = await nodemailer.createTestAccount();
        mailTransporter = nodemailer.createTransport({
            host: 'smtp.ethereal.email',
            port: 587,
            secure: false,
            auth: {
                user: testAccount.user,
                pass: testAccount.pass,
            },
        });
        console.log('📧 No SMTP_HOST set — using a free Ethereal test inbox instead.');
        console.log(`📧 Ethereal login (if you want to check it manually): ${testAccount.user} / ${testAccount.pass}`);
    }
}

const alertQueue = new Queue('price-alert-checks', { connection: bullConnection });
const notificationQueue = new Queue('alert-notifications', { connection: bullConnection });
const priceWarmupQueue = new Queue('price-warmup', { connection: bullConnection });

// Mirrors COINGECKO_ID_MAP in server.js — keep these in sync.
const COINGECKO_ID_MAP = {
    BTC: 'bitcoin',
    ETH: 'ethereum',
    SOL: 'solana',
    XRP: 'ripple',
    DOGE: 'dogecoin',
    ADA: 'cardano',
    MATIC: 'matic-network',
    LTC: 'litecoin',
};

const CACHE_TTL_SECONDS = 60;

// FIXED: the worker previously only read whatever price server.js's
// /api/prices/:symbol route happened to have already cached — meaning an
// alert would silently never fire unless a client had recently, and
// coincidentally, requested that exact symbol. The worker now fetches a
// fresh price itself for every symbol that has an active alert, so alert
// checking no longer depends on outside API traffic.
//
// FIXED (again): once both the alert-checker (every 30s) and the
// price-warmup job (every 45s) could both want the same symbol, they'd
// sometimes both call CoinGecko within a few seconds of each other,
// doubling up requests and tripping CoinGecko's free-tier rate limit
// (HTTP 429). Now we check Redis's remaining TTL first — if a reasonably
// fresh value already exists, we reuse it instead of hitting the API again.
const MIN_FRESHNESS_SECONDS = 20; // skip re-fetching if cached value is younger than this

async function fetchFreshPrice(symbol) {
    const coingeckoId = COINGECKO_ID_MAP[symbol];
    if (!coingeckoId) return null;

    try {
        const ttl = await redisClient.ttl(symbol);
        // ttl > 0 means the key exists and has time left. Our cache TTL is
        // 60s, so a remaining TTL above (60 - MIN_FRESHNESS_SECONDS) means
        // it was set recently enough to just reuse.
        if (ttl > CACHE_TTL_SECONDS - MIN_FRESHNESS_SECONDS) {
            const cached = await redisClient.get(symbol);
            if (cached) return parseFloat(cached);
        }
    } catch {
        // If the TTL check itself fails for any reason, just fall through
        // to a normal fetch below rather than blocking on it.
    }

    try {
        const response = await fetch(
            `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=inr`
        );
        if (!response.ok) {
            console.error(`❌ CoinGecko fetch failed for ${symbol}: status=${response.status}`);
            return null;
        }
        const data = await response.json();
        const price = data?.[coingeckoId]?.inr;
        if (!price) return null;

        // Keep Redis warm too, so server.js's /api/prices/:symbol route
        // and the Go WebSocket stream benefit from this fetch as well,
        // instead of the worker and the API independently hammering
        // CoinGecko for the same symbol.
        await redisClient.set(symbol, price.toString(), { EX: CACHE_TTL_SECONDS });
        return price;
    } catch (err) {
        console.error(`❌ Error fetching price for ${symbol}:`, err.message);
        return null;
    }
}

// FIXED: previously, keeping the dashboard's displayed prices fresh relied
// on the browser tab's own setInterval — but browsers throttle/pause timers
// in background or idle tabs, so prices would go stale ("Waiting for
// Node.js update...") whenever the tab lost focus or the laptop idled.
// This function proactively refreshes every symbol currently on ANY user's
// watchlist, on a fixed schedule, entirely server-side — so the cache stays
// warm independent of whether a browser tab is open, focused, or even
// exists at all.
async function refreshWatchedPrices() {
    const { rows } = await pool.query('SELECT DISTINCT asset_symbol FROM watchlists');
    const symbols = rows.map(r => r.asset_symbol);

    if (symbols.length === 0) return;

    for (const symbol of symbols) {
        await fetchFreshPrice(symbol);
        // Small stagger between symbols in the same tick, so a watchlist
        // with several assets doesn't fire a burst of near-simultaneous
        // requests at CoinGecko.
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

// --- The checker job: runs on a repeating schedule, looks at every
// active alert, fetches a fresh price for its symbol, and compares. ---
async function checkAlerts() {
    const { rows: alerts } = await pool.query(
        `SELECT pa.id, pa.user_id, pa.asset_symbol, pa.target_price, pa.direction, u.email
         FROM price_alerts pa
         JOIN users u ON u.id = pa.user_id
         WHERE pa.is_active = TRUE`
    );

    if (alerts.length === 0) return;

    // Fetch each distinct symbol only once per tick, even if multiple
    // users have alerts on the same asset.
    const uniqueSymbols = [...new Set(alerts.map(a => a.asset_symbol))];
    const freshPrices = {};
    for (const symbol of uniqueSymbols) {
        freshPrices[symbol] = await fetchFreshPrice(symbol);
    }

    for (const alert of alerts) {
        const currentPrice = freshPrices[alert.asset_symbol];

        // Fetch failed or symbol unsupported — nothing to compare against
        // this tick; it'll simply try again on the next one.
        if (currentPrice === null || currentPrice === undefined) continue;

        const targetPrice = parseFloat(alert.target_price);

        const isTriggered =
            (alert.direction === 'above' && currentPrice >= targetPrice) ||
            (alert.direction === 'below' && currentPrice <= targetPrice);

        if (isTriggered) {
            await notificationQueue.add('send-alert', {
                alertId: alert.id,
                userId: alert.user_id,
                userEmail: alert.email,
                symbol: alert.asset_symbol,
                targetPrice,
                currentPrice,
                direction: alert.direction,
            });

            // Deactivate immediately so the same alert doesn't fire again
            // on the next tick before the notification job runs.
            await pool.query(
                'UPDATE price_alerts SET is_active = FALSE, triggered_at = NOW() WHERE id = $1',
                [alert.id]
            );
        }
    }
}

// --- The notification worker: consumes triggered-alert jobs and sends
// a real email via nodemailer (real SMTP if configured, else Ethereal). ---
const notificationWorker = new Worker(
    'alert-notifications',
    async (job) => {
        const { userId, userEmail, symbol, targetPrice, currentPrice, direction } = job.data;

        console.log(
            `🔔 ALERT for user ${userId}: ${symbol} is now ₹${currentPrice} ` +
            `(target was ${direction} ₹${targetPrice})`
        );

        if (!userEmail) {
            console.warn(`⚠️ No email on file for user ${userId} — skipping send.`);
            return;
        }

        const info = await mailTransporter.sendMail({
            from: '"Financial Data Aggregator" <alerts@example.com>',
            to: userEmail,
            subject: `🔔 Price Alert: ${symbol} is now ₹${currentPrice}`,
            text: `Your alert triggered: ${symbol} went ${direction} your target of ₹${targetPrice}.\nCurrent price: ₹${currentPrice}`,
            html: `<p>Your alert triggered:</p>
                   <p><strong>${symbol}</strong> went <strong>${direction}</strong> your target of ₹${targetPrice}.</p>
                   <p>Current price: <strong>₹${currentPrice}</strong></p>`,
        });

        // When using the Ethereal fallback, this prints a URL where you
        // can actually view the sent email in a browser — real SMTP
        // providers won't set this field.
        const previewUrl = nodemailer.getTestMessageUrl(info);
        if (previewUrl) {
            console.log(`📧 Preview this email here: ${previewUrl}`);
        } else {
            console.log(`📧 Email sent to ${userEmail} (message id: ${info.messageId})`);
        }
    },
    { connection: bullConnection }
);

notificationWorker.on('completed', (job) => {
    console.log(`✅ Notification job ${job.id} completed.`);
});

notificationWorker.on('failed', (job, err) => {
    console.error(`❌ Notification job ${job?.id} failed:`, err.message);
});

// --- Boot loader ---
const start = async () => {
    try {
        console.log('🚀 Booting worker process...');
        await redisClient.connect();
        await setupMailTransporter();

        // FIXED: BullMQ v6 removed the old { repeat: { every: ... } } option
        // on Queue.add() entirely — it's now a silent no-op under v6, which
        // is why the checker never actually ran. Repeating jobs are now
        // scheduled via upsertJobScheduler() instead.
        await alertQueue.upsertJobScheduler(
            'check-alerts-scheduler',
            { every: 30_000 },
            { name: 'check-alerts', opts: { removeOnComplete: true, removeOnFail: true } }
        );

        // Keeps every watchlisted symbol's price warm in Redis, on a fixed
        // 45-second cycle — comfortably under the 60s cache TTL — so the
        // dashboard never depends on a browser tab's own timer to stay fresh.
        await priceWarmupQueue.upsertJobScheduler(
            'price-warmup-scheduler',
            { every: 45_000 },
            { name: 'warmup-prices', opts: { removeOnComplete: true, removeOnFail: true } }
        );

        new Worker(
            'price-alert-checks',
            async () => {
                await checkAlerts();
            },
            { connection: bullConnection }
        );

        new Worker(
            'price-warmup',
            async () => {
                await refreshWatchedPrices();
            },
            { connection: bullConnection }
        );

        console.log('✅ Worker is running — checking alerts every 30 seconds, warming watchlisted prices every 45 seconds.');
    } catch (err) {
        console.error('❌ CRITICAL WORKER BOOT ERROR:', err.message);
        process.exit(1);
    }
};

start();