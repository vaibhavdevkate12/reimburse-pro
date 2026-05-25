"use client";
import React, { createContext, useContext, useSyncExternalStore, useCallback } from 'react';

type Currency = 'USD' | 'INR';

interface CurrencyContextType {
  currency: Currency;
  symbol: string;
  setCurrency: (c: Currency) => void;
}

const CurrencyContext = createContext<CurrencyContextType>({
  currency: 'INR',
  symbol: '₹',
  setCurrency: () => {},
});

const subscribe = (listener: () => void) => {
  window.addEventListener('storage', listener);
  // Custom event for same-tab updates
  window.addEventListener('erp_currency_changed', listener);
  return () => {
    window.removeEventListener('storage', listener);
    window.removeEventListener('erp_currency_changed', listener);
  };
};

const getSnapshot = () => {
  return localStorage.getItem('erp_currency') || 'INR';
};

const getServerSnapshot = () => 'INR';

export const CurrencyProvider = ({ children }: { children: React.ReactNode }) => {
  const currencyValue = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const currency: Currency = (currencyValue === 'USD') ? 'USD' : 'INR';

  const setCurrency = useCallback((c: Currency) => {
    localStorage.setItem('erp_currency', c);
    // Dispatch event to trigger useSyncExternalStore update in the same tab
    window.dispatchEvent(new Event('erp_currency_changed'));
  }, []);

  const symbol = currency === 'USD' ? '$' : '₹';

  return (
    <CurrencyContext.Provider value={{ currency, symbol, setCurrency }}>
      {children}
    </CurrencyContext.Provider>
  );
};

export const useCurrency = () => useContext(CurrencyContext);
