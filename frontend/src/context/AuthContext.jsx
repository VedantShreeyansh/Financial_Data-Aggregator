import { createContext, useContext, useState, useCallback } from 'react';
import { API_BASE_URL } from '../config';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(() => sessionStorage.getItem('token'));
  const [email, setEmail] = useState(() => sessionStorage.getItem('email'));

  const login = useCallback(async (loginEmail, password) => {
    const res = await fetch(`${API_BASE_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: loginEmail, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');

    setToken(data.token);
    setEmail(loginEmail);
    sessionStorage.setItem('token', data.token);
    sessionStorage.setItem('email', loginEmail);
    return data;
  }, []);

  const register = useCallback(async (registerEmail, password) => {
    const res = await fetch(`${API_BASE_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: registerEmail, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    return data;
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setEmail(null);
    sessionStorage.removeItem('token');
    sessionStorage.removeItem('email');
  }, []);

  return (
    <AuthContext.Provider value={{ token, email, login, register, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
