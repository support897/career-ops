"use client";

import { createContext, useContext, useEffect, useState } from "react";

export type ProfileAccount = {
  id: string;
  name: string;
  roleTitle: string;
  avatarIcon: string;
  color: string;
};

export const ACCOUNTS: ProfileAccount[] = [
  {
    id: "default",
    name: "Ilse Placencia",
    roleTitle: "AI Automation Specialist & Marketing Engineer",
    avatarIcon: "⚡",
    color: "from-blue-600 to-indigo-600",
  },
];


const ACCOUNT_KEY = "career-ops:active-account";

type AccountContextType = {
  account: ProfileAccount;
  setAccountId: (id: string) => void;
  accounts: ProfileAccount[];
};

const AccountContext = createContext<AccountContextType>({
  account: ACCOUNTS[0],
  setAccountId: () => {},
  accounts: ACCOUNTS,
});

export function AccountProvider({ children }: { children: React.ReactNode }) {
  const [account, setAccount] = useState<ProfileAccount>(ACCOUNTS[0]);

  useEffect(() => {
    try {
      const savedId = localStorage.getItem(ACCOUNT_KEY);
      if (savedId) {
        const found = ACCOUNTS.find((a) => a.id === savedId);
        if (found) setAccount(found);
      }
    } catch {}
  }, []);

  const handleSetAccountId = (id: string) => {
    const found = ACCOUNTS.find((a) => a.id === id);
    if (found) {
      setAccount(found);
      try {
        localStorage.getItem(ACCOUNT_KEY) !== id && localStorage.setItem(ACCOUNT_KEY, id);
        // Force full page reload on account switch to cleanly re-fetch DB queries
        window.location.reload();
      } catch {}
    }
  };

  return (
    <AccountContext.Provider
      value={{
        account,
        setAccountId: handleSetAccountId,
        accounts: ACCOUNTS,
      }}
    >
      {children}
    </AccountContext.Provider>
  );
}

export function useAccount() {
  return useContext(AccountContext);
}
