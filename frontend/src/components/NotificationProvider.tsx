import React, { createContext, useContext, useState, useCallback, ReactNode } from 'react';

type NotificationType = 'success' | 'error' | 'info';

interface Notification {
  id: number;
  message: string;
  type: NotificationType;
}

interface NotificationContextValue {
  notify: (message: string, type?: NotificationType) => void;
}

const NotificationContext = createContext<NotificationContextValue>({
  notify: () => {},
});

export const useNotify = () => useContext(NotificationContext);

let nextId = 0;

export const NotificationProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const notify = useCallback((message: string, type: NotificationType = 'info') => {
    const id = nextId++;
    setNotifications(prev => [...prev, { id, message, type }]);
    setTimeout(() => {
      setNotifications(prev => prev.filter(n => n.id !== id));
    }, 4000);
  }, []);

  return (
    <NotificationContext.Provider value={{ notify }}>
      {children}
      <div style={{
        position: 'fixed', top: 16, right: 16, zIndex: 10000,
        display: 'flex', flexDirection: 'column', gap: 8,
      }}>
        {notifications.map(n => (
          <div key={n.id} style={{
            padding: '12px 20px', borderRadius: 8, color: '#fff',
            fontSize: 14, boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            backgroundColor: n.type === 'error' ? '#e53935' : n.type === 'success' ? '#43a047' : '#1e88e5',
            animation: 'slideIn 0.3s ease',
          }}>
            {n.message}
          </div>
        ))}
      </div>
    </NotificationContext.Provider>
  );
};