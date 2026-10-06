import { API_BASE_URL } from './config';

// Wraps fetch with the Authorization header and consistent error handling.
export async function apiRequest(path, token, options = {}) {
  // Only set Content-Type when there's an actual body to send — Fastify's
  // default JSON parser throws a 400 if it sees application/json with no
  // body at all, which is exactly what DELETE requests without a body do.
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...options.headers,
  };

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data.error || `Request failed with status ${res.status}`);
  }

  return data;
}