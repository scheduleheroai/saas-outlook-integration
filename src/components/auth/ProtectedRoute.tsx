// src/components/auth/ProtectedRoute.tsx
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/lib/supabaseClient';
import { useEffect } from 'react';

interface UserSettings {
  user_id: string;
  onboarding_completed?: boolean; // Make optional as it might not exist initially
}

export default function ProtectedRoute() {
  const { session, user, loading: authLoading } = useAuth();
  const location = useLocation();

  // Fetch user settings specifically for the onboarding check
  const { data: userSettings, isLoading: settingsLoading, error: settingsError } = useQuery<UserSettings | null>({
    queryKey: ['userSettingsOnboarding', user?.id], // Ensure this key matches invalidation
    queryFn: async () => {
      if (!user?.id) return null;
      const { data, error } = await supabase
        .from('user_settings')
        .select('user_id, onboarding_completed')
        .eq('user_id', user.id)
        .maybeSingle();

      if (error) {
        console.error("Error fetching user settings for onboarding:", error);
        throw error;
      }
      // Default to false if no record exists yet for the user
      return data ?? { user_id: user.id, onboarding_completed: false };
    },
    enabled: !!user && !authLoading,
    staleTime: 5 * 60 * 1000, // How long data is considered fresh
    refetchOnWindowFocus: false, // Don't refetch just on window focus
  });

  const isLoading = authLoading || settingsLoading;

  useEffect(() => {
    if (settingsError) {
        console.error("Failed to load user settings for routing:", settingsError);
        // Potentially show an error state or retry logic here
    }
  }, [settingsError]);


  if (isLoading) {
    // Loading state: Show a spinner or skeleton screen
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100 dark:bg-gray-900">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 dark:border-blue-400"></div>
      </div>
    );
  }

  if (!session || !user) {
    // Not logged in -> Redirect to login
    console.log("ProtectedRoute: No session/user, redirecting to /login.");
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Logged in, check onboarding status
  // Rule 1: If onboarding is NOT complete and user is trying to access anything OTHER than /onboarding -> Redirect TO /onboarding
  if (userSettings && !userSettings.onboarding_completed && location.pathname !== '/onboarding') {
     console.log(`ProtectedRoute: User logged in, onboarding NOT complete (settings found: ${userSettings.onboarding_completed}), path is "${location.pathname}". Redirecting to /onboarding.`);
     return <Navigate to="/onboarding" replace />;
  }

  // Rule 2: If user is logged in, onboarding IS complete, but they somehow landed on /onboarding -> Redirect TO /dashboard
  // This is handled inside OnboardingPage itself now to prevent rendering Step 1.

  // If we reach here:
  // - User is logged in.
  // - EITHER onboarding is complete (and they can access any protected route like /dashboard/*)
  // - OR onboarding is not complete BUT they are correctly accessing /onboarding.
  console.log(`ProtectedRoute: User logged in, conditions met (onboarding_completed: ${userSettings?.onboarding_completed}, path: ${location.pathname}). Rendering Outlet.`);
  return <Outlet />;
}