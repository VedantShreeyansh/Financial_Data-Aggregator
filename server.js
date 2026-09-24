import "dotenv/config";
import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyCors from "@fastify/cors";
import pkg from 'pg';
import bcrypt from 'bcrypt';
import { createClient } from 'redis';

const { Pool } = pkg;
const fastify = Fastify({ logger: true });

// FIXED: the frontend (Vite dev server on :5173) and this API (:3000) are
// different origins to the browser, which blocks cross-origin requests by
// default — this is what caused the "Failed to fetch" error on register/login.
fastify.register(fastifyCors, {
    origin: [
        'http://localhost:5173', 'http://127.0.0.1:5173',
        'http://localhost:5174', 'http://127.0.0.1:5174',
    ],
});

fastify.register(fastifyJwt, {
    secret: process.env.JWT_SECRET // set this in your .env file — never hardcode it
});

// 1. Configure the connection pool using environment variables
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

redisClient.on('error', err => console.error('Redis Client Error', err));

// 2. Creates your tables if they don't exist. NOTE: the destructive
// "DROP TABLE" debug line has been removed — it was wiping all users
// and watchlists on every server restart.
async function initDatabase() {
    try {
        console.log('🔄 Verifying database connection...');

        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS watchlists (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                asset_symbol VARCHAR(10) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE (user_id, asset_symbol)
            );

            CREATE TABLE IF NOT EXISTS price_alerts (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                asset_symbol VARCHAR(10) NOT NULL,
                target_price NUMERIC NOT NULL,
                direction VARCHAR(5) NOT NULL CHECK (direction IN ('above', 'below')),
                is_active BOOLEAN DEFAULT TRUE,
                triggered_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('📦 PostgreSQL tables verified/created successfully.');
    } catch (dbError) {
        // Previously this was an empty catch block, which meant a failed
        // table creation would fail silently and the server would boot
        // "successfully" into a broken state. Fail loudly instead.
        console.error('❌ Failed to initialize database:', dbError);
        process.exit(1);
    }
}

fastify.post('/api/register', async (request, reply) => {

    const { email, password } = request.body;

    if (!email || !password) {
        return reply.code(400).send({ error: 'Email and password are required' });
    }

    try {
        const existingUser = await pool.query('SELECT id FROM users WHERE email = $1', [email]);

        if (existingUser.rows.length > 0) {
            return reply.code(400).send({ error: "Email is already registered" });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        await pool.query('INSERT INTO users (email, password) VALUES ($1, $2)', [email, hashedPassword]);

        return reply.code(201).send({ message: "User registered successfully", email });
    }
    catch (error) {
        fastify.log.error(error);
        return reply.code(500).send({ error: 'Internal Server error' });
    }
});

fastify.post('/api/login', async (request, reply) => {

    const { email, password } = request.body;

    if (!email || !password) {
        return reply.code(400).send({ error: 'Email and password are required' });
    }

    try {
        // check if the user exists, extracts it if it does
        const userResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

        if (userResult.rows.length === 0) {
            return reply.code(401).send({ error: "Invalid email or password" });
        }

        const user = userResult.rows[0];

        // bcrypt compares the plaintext password against the stored hash
        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return reply.code(401).send({ error: 'Invalid email or password' });
        }

        // If it matches, sign a token and return it
        const token = fastify.jwt.sign({ id: user.id, email: user.email });
        return reply.code(200).send({ message: "Login successful", token });
    }
    catch (error) {
        fastify.log.error(error);
        return reply.code(500).send({ error: 'Internal Server error' });
    }
});

// CoinGecko's public API uses lowercase full coin IDs, not ticker symbols,
// so we need a small lookup table. Add more pairs here as you support more assets.
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

fastify.get('/api/prices/:symbol', async (request, reply) => {
    const { symbol } = request.params;
    const assetSymbol = symbol.toUpperCase();
    const coingeckoId = COINGECKO_ID_MAP[assetSymbol];

    if (!coingeckoId) {
        return reply.code(400).send({ error: `Unsupported symbol: ${assetSymbol}` });
    }

    try {
        const cachedPrice = await redisClient.get(assetSymbol);

        if (cachedPrice) {
            return reply.code(200).send({
                symbol: assetSymbol,
                price_inr: parseFloat(cachedPrice),
                fetched_at: new Date().toISOString(),
                source: "In-Memory Redis Cache"
            });
        }

        // FIXED: swapped the broken/unverified CryptoCompare URL for
        // CoinGecko's public, keyless /simple/price endpoint, which is
        // confirmed working without any signup or API key.
        const marketResponse = await fetch(
            `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=inr`
        );

        if (!marketResponse.ok) {
            fastify.log.error(`CoinGecko fetch failed: status=${marketResponse.status}`);
            return reply.code(502).send({ error: 'Upstream market data provider error' });
        }

        const marketData = await marketResponse.json();
        const priceInr = marketData?.[coingeckoId]?.inr;

        if (!priceInr) {
            return reply.code(404).send({ error: `Could not fetch live data for symbol: ${assetSymbol}` });
        }

        await redisClient.set(assetSymbol, priceInr.toString(), { EX: 60 });

        return reply.code(200).send({
            symbol: assetSymbol,
            price_inr: priceInr,
            fetched_at: new Date().toISOString(),
            source: "Live Market API Feed"
        });

    } catch (error) {
        // FIXED: previously only the 401 branch sent a reply; any other
        // error (Redis down, fetch throwing, bad JSON) fell through with
        // no response sent at all, leaving the client hanging until timeout.
        fastify.log.error(error);
        if (error.statusCode === 401 || (error.message && error.message.includes('Authorization'))) {
            return reply.code(401).send({ error: 'Unauthorized: Invalid or missing token' });
        }
        return reply.code(500).send({ error: 'Internal Server error' });
    }
});

// endpoint for getting/adding to the asset watchlist for the user
fastify.post('/api/watchlist', async (request, reply) => {

    try {
        const decodedUser = await request.jwtVerify();

        const { asset_symbol } = request.body;

        if (!asset_symbol) {
            return reply.code(400).send({ error: 'Asset symbol is required' });
        }

        // FIXED: normalize case before storing so "btc" and "BTC" don't
        // become separate watchlist rows.
        const normalizedSymbol = asset_symbol.toUpperCase();

        await pool.query(
            'INSERT INTO watchlists (user_id, asset_symbol) VALUES ($1, $2) ON CONFLICT (user_id, asset_symbol) DO NOTHING',
            [decodedUser.id, normalizedSymbol]
        );

        return reply.code(201).send({
            success: true,
            message: normalizedSymbol
        });
    } catch (error) {
        fastify.log.error(error);
        if (error.statusCode === 401 || (error.message && error.message.includes('Authorization'))) {
            return reply.code(401).send({ error: 'Unauthorized: Invalid or missing token' });
        }
        return reply.code(500).send({ error: 'Internal Server error' });
    }
});

// endpoint for creating a price alert
fastify.post('/api/alerts', async (request, reply) => {
    try {
        const decodedUser = await request.jwtVerify();

        const { asset_symbol, target_price, direction } = request.body;

        if (!asset_symbol || !target_price || !direction) {
            return reply.code(400).send({ error: 'asset_symbol, target_price, and direction are required' });
        }

        if (!['above', 'below'].includes(direction)) {
            return reply.code(400).send({ error: "direction must be 'above' or 'below'" });
        }

        const normalizedSymbol = asset_symbol.toUpperCase();

        if (!COINGECKO_ID_MAP[normalizedSymbol]) {
            return reply.code(400).send({ error: `Unsupported symbol: ${normalizedSymbol}` });
        }

        const result = await pool.query(
            `INSERT INTO price_alerts (user_id, asset_symbol, target_price, direction)
             VALUES ($1, $2, $3, $4) RETURNING id, asset_symbol, target_price, direction, created_at`,
            [decodedUser.id, normalizedSymbol, target_price, direction]
        );

        return reply.code(201).send({ success: true, alert: result.rows[0] });
    } catch (error) {
        fastify.log.error(error);
        if (error.statusCode === 401 || (error.message && error.message.includes('Authorization'))) {
            return reply.code(401).send({ error: 'Unauthorized: Invalid or missing token' });
        }
        return reply.code(500).send({ error: 'Internal Server error' });
    }
});

// endpoint for listing a user's own alerts
fastify.get('/api/alerts', async (request, reply) => {
    try {
        const decodedUser = await request.jwtVerify();

        const result = await pool.query(
            'SELECT id, asset_symbol, target_price, direction, is_active, triggered_at, created_at FROM price_alerts WHERE user_id = $1 ORDER BY created_at DESC',
            [decodedUser.id]
        );

        return reply.code(200).send({ alerts: result.rows });
    } catch (error) {
        fastify.log.error(error);
        if (error.statusCode === 401 || (error.message && error.message.includes('Authorization'))) {
            return reply.code(401).send({ error: 'Unauthorized: Invalid or missing token' });
        }
        return reply.code(500).send({ error: 'Internal Server error' });
    }
});

// 3. Simple Health Check Endpoint
fastify.get('/health', async (request, reply) => {
    return { status: "OK", server: "Fastify + Postgres" };
});

// 4. The Boot Loader Function
const start = async () => {
    try {
        console.log('🚀 Booting server...');
        await redisClient.connect();
        await initDatabase();

        const address = await fastify.listen({ port: process.env.PORT || 3000, host: '0.0.0.0' });
        console.log(`🚀 Server listening on ${address}`);
    } catch (err) {
        console.error('❌ CRITICAL BOOT ERROR:', err.message);
        process.exit(1);
    }
};

start();