/**
 * useAdmin Hook
 *
 * Client-side hook to check if the current user is an admin.
 * Uses the existing /api/user endpoint to get session info.
 */

"use client";

import { useState, useEffect } from "react";

interface AdminState {
  isAdmin: boolean;
  isLoading: boolean;
  username: string | null;
}

/**
 * Hook that checks whether the current user has admin privileges.
 * Returns `{ isAdmin, isLoading, username }`.
 */
export function useAdmin(): AdminState {
  const [state, setState] = useState<AdminState>({
    isAdmin: false,
    isLoading: true,
    username: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function checkAdmin() {
      try {
        const res = await fetch("/api/v1/user");
        if (!res.ok) {
          setState({ isAdmin: false, isLoading: false, username: null });
          return;
        }

        const data = await res.json();
        if (!cancelled) {
          setState({
            isAdmin: data.isAdmin ?? false,
            isLoading: false,
            username: data.username ?? null,
          });
        }
      } catch {
        if (!cancelled) {
          setState({ isAdmin: false, isLoading: false, username: null });
        }
      }
    }

    checkAdmin();

    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
