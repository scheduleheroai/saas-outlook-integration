// src/contexts/AuthContext.tsx
import React, { createContext, useContext, useEffect, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';

interface Profile {
  user_id: string;
  full_name: string | null;
  email: string;
}

interface AuthContextType {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  loading: boolean;
  isFoundingMember: boolean;
  signOut: () => Promise<{ error: Error | null }>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const FOUNDING_MEMBER_CUTOFF_DATE = new Date('2025-06-01T00:00:00.000Z');

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [isFoundingMember, setIsFoundingMember] = useState<boolean>(false);
  const queryClient = useQueryClient();

  const { data: profile } = useQuery<Profile | null>({
    queryKey: ['profile', user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      console.log("Fetching profile for user:", user.id);
      try {
        const { data, error, status } = await supabase
          .from('profiles')
          .select('*')
          .eq('user_id', user.id)
          .single();

        if (error && status !== 406) {
          console.error("Error fetching profile:", error);
          throw error;
        }
        
        const fetchedProfile = data as Omit<Profile, 'email' | 'user_id'> & { email?: string | null, user_id?: string, full_name?: string | null };
        
        return {
          ...fetchedProfile,
          user_id: user.id, 
          email: fetchedProfile?.email || user.email || 'No Email Found', 
          full_name: fetchedProfile?.full_name || null,
        };

      } catch (err) {
        console.error("Query function error:", err);
        return null;
      }
    },
    enabled: !!user?.id,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    setLoading(true);
    supabase.auth.getSession().then(({ data: { session: initialSession } }) => {
      setSession(initialSession);
      const initialUser = initialSession?.user ?? null;
      setUser(initialUser);

      if (initialUser?.created_at) {
        setIsFoundingMember(new Date(initialUser.created_at) < FOUNDING_MEMBER_CUTOFF_DATE);
      } else {
        setIsFoundingMember(false);
      }
      setLoading(false);
      console.log("Initial session:", initialSession);
    }).catch(error => {
      console.error("Error getting initial session:", error);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, changedSession) => {
        console.log("Auth state changed:", _event, changedSession);
        setSession(changedSession);
        const currentUser = changedSession?.user ?? null;
        setUser(currentUser);

        if (currentUser?.created_at) {
          setIsFoundingMember(new Date(currentUser.created_at) < FOUNDING_MEMBER_CUTOFF_DATE);
        } else {
          setIsFoundingMember(false);
        }

        if (!currentUser) {
          queryClient.removeQueries({ queryKey: ['profile'] });
          if (_event === 'SIGNED_OUT') {
            console.log("User signed out (detected by listener).");
          }
        }
        setLoading(false);
      }
    );

    return () => {
      console.log("Unsubscribing from auth state changes.");
      subscription.unsubscribe();
    };
  }, [queryClient]);

  const signOut = async (): Promise<{ error: Error | null }> => {
    setLoading(true);
    try {
      console.log("Signing out via context function...");
      const { error } = await supabase.auth.signOut();
      if (error) {
        console.error('Error signing out (supabase):', error);
        return { error };
      }
      console.log("Supabase signOut successful.");
      return { error: null };
    } catch (error: any) {
      console.error('Sign out function exception:', error);
      return { error: error instanceof Error ? error : new Error('Unknown sign out error') };
    }
  };

  const value = {
    session,
    user,
    profile: profile ?? null,
    loading,
    isFoundingMember,
    signOut,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}