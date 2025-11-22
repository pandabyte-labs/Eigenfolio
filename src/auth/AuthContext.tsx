import React, { createContext, useContext, useEffect, useState } from "react";
import type { DataSourceMode } from "../data/localStore";
import { getPreferredMode, setPreferredMode } from "../data/localStore";
import { createCloudClient, type CloudClient } from "../data/cloudClient";

type AuthState = {
  isAuthenticated: boolean;
  mode: DataSourceMode;
  userLabel: string | null;
};

type AuthContextValue = {
  auth: AuthState;
  loginWithPasskey: () => Promise<void>;
  logout: () => void;
  openAuthModal: () => void;
  closeAuthModal: () => void;
  isAuthModalOpen: boolean;
  cloudClient: CloudClient | null;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/**
 * AuthProvider prepares the UI for a future passkey + 2FA based login.
 *
 * IMPORTANT:
 * - There is deliberately no real backend interaction here yet.
 * - The login method just simulates authentication so that the UI and mode
 *   switching can be wired without depending on backend readiness.
 * - Later, the `loginWithPasskey` implementation will:
 *     - obtain a challenge from the backend,
 *     - use WebAuthn APIs to sign it with a passkey,
 *     - verify the result on the backend,
 *     - and only then mark the user as authenticated.
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

  const [cloudClient, setCloudClient] = useState<CloudClient | null>(null);
  const [isAuthModalOpen, setAuthModalOpen] = useState(false);

  useEffect(() => {
    // For now we simply toggle the preferred mode based on authentication.
    // Later this can be refined to respect explicit user choice.
    if (auth.isAuthenticated) {
      setPreferredMode("cloud");
    } else {
      setPreferredMode("local-only");
    }
  }, [auth.isAuthenticated]);

  const loginWithPasskey = async () => {
    // TODO: Implement real WebAuthn + backend challenge/verification.
    // For now we just simulate a successful login and prepare a cloud client
    // instance that the rest of the app can use once a backend is available.
    const client = createCloudClient();
    setCloudClient(client);
    setAuth((prev) => ({
      ...prev,
      isAuthenticated: true,
      mode: "cloud",
      userLabel: "Cloud user",
    }));
    setAuthModalOpen(false);
  };

  const logout = () => {
    setCloudClient(null);
    setAuth({
      isAuthenticated: false,
      mode: "local-only",
      userLabel: null,
    });
  };

  const openAuthModal = () => setAuthModalOpen(true);
  const closeAuthModal = () => setAuthModalOpen(false);

  const value: AuthContextValue = {
    auth,
    loginWithPasskey,
    logout,
    openAuthModal,
    closeAuthModal,
    isAuthModalOpen,
    cloudClient,
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
