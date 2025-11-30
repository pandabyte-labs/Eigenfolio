import React, { createContext, useContext, useState } from "react";
import type { DataSourceMode } from "../data/localStore";
import { getPreferredMode, setPreferredMode } from "../data/localStore";

type AuthState = {
  isAuthenticated: boolean;
  mode: DataSourceMode;
  userLabel: string | null;
};

type AuthContextValue = {
  auth: AuthState;
  logout: () => void;
  openAuthModal: () => void;
  closeAuthModal: () => void;
  isAuthModalOpen: boolean;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * AuthProvider controls a simple local-only auth state for the UI.
 *
 * There is deliberately no real backend connection here. The only thing
 * we keep track of is whether the user is "logged in" from the UI
 * perspective, and which data source mode is active. In this build the
 * mode is always local-only.
 */
export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [auth, setAuth] = useState<AuthState>(() => {
    const mode = getPreferredMode();
    return {
      isAuthenticated: false,
      mode,
      userLabel: null,
    };
  });

  const [isAuthModalOpen, setAuthModalOpen] = useState(false);

  const openAuthModal = () => setAuthModalOpen(true);
  const closeAuthModal = () => setAuthModalOpen(false);

  const logout = () => {
    setAuth({
      isAuthenticated: false,
      mode: "local-only",
      userLabel: null,
    });
    setPreferredMode("local-only");
    setAuthModalOpen(false);
  };

  const value: AuthContextValue = {
    auth,
    logout,
    openAuthModal,
    closeAuthModal,
    isAuthModalOpen,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return ctx;
}
