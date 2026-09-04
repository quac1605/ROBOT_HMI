import { useEffect, useRef, useState } from 'react';
import { AuthContext } from './AuthContext.js';
import { robotClient } from '../clients/index.js';

export default function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState('checking');
  const [sessionError, setSessionError] = useState(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    robotClient.getSession().then(({ user: nextUser }) => {
      if (current !== generation.current) return;
      setUser(nextUser);
      setStatus(nextUser ? 'authenticated' : 'anonymous');
    }).catch((error) => {
      if (current !== generation.current) return;
      setSessionError(error.message);
      setStatus('error');
    });
    return () => { generation.current += 1; };
  }, []);

  async function signIn(credentials) {
    const current = ++generation.current;
    const result = await robotClient.login(credentials);
    if (current !== generation.current) return;
    setUser(result.user);
    setSessionError(null);
    setStatus('authenticated');
  }

  async function signOut() {
    const current = ++generation.current;
    await robotClient.logout();
    if (current !== generation.current) return;
    setUser(null);
    setStatus('anonymous');
  }

  return (
    <AuthContext.Provider value={{ user, status, sessionError, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}