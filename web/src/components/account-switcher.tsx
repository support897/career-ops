"use client";

import { useState, useRef, useEffect } from "react";
import { useAccount } from "@/components/account-context";
import { UserCheck, ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/cn";

export function AccountSwitcher({ compact = false }: { compact?: boolean }) {
  const { account, setAccountId, accounts } = useAccount();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="relative inline-block text-left" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex items-center gap-2.5 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground transition-all hover:bg-surface-hover hover:border-brand/40 shadow-xs",
          compact && "px-2 py-1"
        )}
      >
        <span
          className={cn(
            "flex size-6 items-center justify-center rounded-full bg-gradient-to-r text-xs text-white shadow-xs font-semibold",
            account.color
          )}
        >
          {account.avatarIcon}
        </span>
        <div className="flex flex-col text-left">
          <span className="font-semibold text-foreground leading-none">{account.name}</span>
          <span className="text-[10px] text-muted leading-tight mt-0.5">{account.roleTitle}</span>
        </div>
        <ChevronDown className="ml-1 size-3.5 text-muted transition-transform duration-200" style={{ transform: open ? "rotate(180deg)" : "none" }} />
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1.5 w-64 origin-top-right rounded-xl border border-border bg-surface p-1.5 shadow-xl ring-1 ring-black/5 dark:ring-white/10 backdrop-blur-md">
          <div className="px-2.5 py-1.5 text-[11px] font-semibold text-faint uppercase tracking-wider">
            Switch Target Profile
          </div>
          <div className="space-y-1">
            {accounts.map((acc) => {
              const isSelected = acc.id === account.id;
              return (
                <button
                  key={acc.id}
                  type="button"
                  onClick={() => {
                    setAccountId(acc.id);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-xs transition-colors text-left",
                    isSelected ? "bg-brand-soft font-semibold text-brand-text" : "hover:bg-surface-hover text-muted hover:text-foreground"
                  )}
                >
                  <span
                    className={cn(
                      "flex size-7 items-center justify-center rounded-full bg-gradient-to-r text-xs text-white shadow-xs font-semibold shrink-0",
                      acc.color
                    )}
                  >
                    {acc.avatarIcon}
                  </span>
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="font-medium truncate">{acc.name}</span>
                    <span className="text-[10px] opacity-80 truncate">{acc.roleTitle}</span>
                  </div>
                  {isSelected && <Check className="size-4 shrink-0 text-brand text-brand-text" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
