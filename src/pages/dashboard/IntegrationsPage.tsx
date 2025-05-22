import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Calendar, Trash2, AlertCircle, Link as LinkIcon, CheckCircle2, Info, Loader2 } from "lucide-react";
import { supabase } from "@/lib/supabaseClient";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { SiGooglecalendar, SiCalendly, SiSquare } from "react-icons/si";
import { useAuth } from "@/contexts/AuthContext"; // Import useAuth

interface CalendarIntegration {
  id: string;
  provider: string;
  account_email: string;
  status: string;
}

interface CalendarCheckResponse {
  status: string;
  error?: string;
  missingVars?: string[];
  configuredProviders?: string[];
}

type CalendarProvider = "google" | "acuity" | "calendly" | "square";

interface ProviderConfig {
  name: string;
  icon?: React.ReactNode;
  checkKey: string;
}

const PROVIDER_CONFIGS: Record<CalendarProvider, ProviderConfig> = {
  google: { name: "Google Calendar", checkKey: "google", icon: <SiGooglecalendar className="h-5 w-5 mr-2" /> },
  acuity: { name: "Acuity Scheduling", checkKey: "acuity", icon: <Calendar className="h-5 w-5 mr-2" /> },
  calendly: { name: "Calendly", checkKey: "calendly", icon: <SiCalendly className="h-5 w-5 mr-2" /> },
  square: { name: "Square Appointments", checkKey: "square", icon: <SiSquare className="h-5 w-5 mr-2" /> },
};

const ALLOWED_GOOGLE_CALENDAR_USERS = [
  "test@test.com",
  "oshagreyjoy.118694@gmail.com"
];

export default function IntegrationsPage() {
  const { user } = useAuth(); // Get current user from AuthContext
  const [selectedIntegrationId, setSelectedIntegrationId] = useState<string | null>(null);
  const [isBackendConfigured, setIsBackendConfigured] = useState(true); // Assume configured, verify below
  const [backendConfigError, setBackendConfigError] = useState<string | null>(null);
  const [configuredProviders, setConfiguredProviders] = useState<string[]>([]);
  const [isCheckingBackendConfig, setIsCheckingBackendConfig] = useState(true); // New state for calendar-check loading
  const queryClient = useQueryClient();

  useEffect(() => {
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) throw new Error("Not authenticated");
        const res = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/calendar-check`,
          { headers: { Authorization: `Bearer ${session.access_token}` } }
        );
        const json: CalendarCheckResponse = await res.json();
        if (!res.ok || json.error) {
          if (json.missingVars && json.missingVars.length > 0) {
             throw new Error(`Missing backend config for: ${json.missingVars.join(', ')}. Some providers may be unavailable.`);
          }
          throw new Error(json.error || "Configuration check failed");
        }
        setConfiguredProviders(json.configuredProviders || []);
        setIsBackendConfigured(true);
      } catch (e: any) {
        // Even if specific providers are not configured, the page itself might be "configured" to run
        setIsBackendConfigured(true); 
        setBackendConfigError(e.message);
      } finally {
        setIsCheckingBackendConfig(false);
      }
    })();
  }, []);

  const {
    data: integrations = [],
    isLoading: isLoadingIntegrations,
    error: integrationsError
  } = useQuery<CalendarIntegration[]>({
    queryKey: ["calendar-integrations"],
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/calendar-integration`,
        { headers: { Authorization: `Bearer ${session.access_token}` } }
      );
      if (!res.ok) {
        const errText = await res.text();
        try {
            const errJson = JSON.parse(errText);
            throw new Error(errJson.error || res.statusText);
        } catch {
            throw new Error(errText || res.statusText);
        }
      }
      return res.json();
    },
    refetchOnWindowFocus: false
  });

  const connectCalendar = useMutation({
    mutationFn: async (provider: CalendarProvider) => {
      if (integrations.length > 0) {
        toast.error("A calendar is already connected. Please disconnect it first.");
        throw new Error("An existing calendar integration is active. Please disconnect it before adding a new one.");
      }
      
      const providerConfig = PROVIDER_CONFIGS[provider];
      const providerName = providerConfig.name;

      if (provider === "google") {
        const isCurrentUserAllowedForGoogle = user?.email && ALLOWED_GOOGLE_CALENDAR_USERS.includes(user.email);
        if (!isCurrentUserAllowedForGoogle) {
          toast.error("Google Calendar integration is currently available for select users only.");
          throw new Error("Google Calendar integration is currently available for select users only.");
        }
      }
      
      if (!configuredProviders.includes(providerConfig.checkKey)) {
        toast.error(`${providerName} is not available due to backend configuration. Please contact support or check server logs.`);
        throw new Error(`${providerName} is not configured on the backend.`);
      }
      
      if (!isBackendConfigured) { 
          throw new Error(`Backend not generally configured for ${providerName}. Please check server logs.`);
      }

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");

      const currentPath = window.location.pathname;

      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/calendar-integration`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ provider, returnPath: currentPath })
        }
      );
      const data = await res.json(); 
      if (!res.ok) {
        throw new Error(data.error || res.statusText || `Failed to initiate connection for ${provider}`);
      }
      return data.url as string;
    },
    onSuccess: (url) => {
      window.location.href = url;
    },
    onError: (err: any) => {
      toast.error(`Connect failed: ${err.message}`);
    }
  });

  const disconnectCalendar = useMutation({
    mutationFn: async (id: string) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error("Not authenticated");
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/calendar-integration`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ integrationId: id })
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-integrations"]});
      toast.success("Calendar disconnected successfully.");
      setSelectedIntegrationId(null);
    },
    onError: (err: any) => {
      toast.error(`Disconnect failed: ${err.message}`);
    }
  });

  const getProviderDisplayName = (providerKey: string): string => {
    return PROVIDER_CONFIGS[providerKey as CalendarProvider]?.name || providerKey.charAt(0).toUpperCase() + providerKey.slice(1);
  };

  if (!isCheckingBackendConfig && !isLoadingIntegrations && backendConfigError && configuredProviders.length === 0) { 
    return (
      <div className="space-y-8 p-4 md:p-6">
         <div>
            <h1 className="text-3xl font-bold tracking-tight">Calendar Connections</h1>
            <p className="text-gray-600 mt-1">
            Connect a calendar to allow the AI Employee to manage your appointments. Only one calendar can be active at a time.
            </p>
        </div>
        <div className="p-6 bg-red-50 border border-red-200 rounded-lg">
            <div className="flex items-center">
            <AlertCircle className="h-5 w-5 text-red-500 mr-2" />
            <span className="text-lg font-semibold text-red-700">Critical Backend Misconfiguration</span>
            </div>
            <p className="mt-2 text-red-600">{backendConfigError}</p>
            <p className="mt-1 text-sm text-red-500">Please contact support or check server logs. Calendar integrations are currently unavailable.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 p-4 md:p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Calendar Connections</h1>
        <p className="text-gray-600 mt-1">
          Connect a calendar to allow the AI Employee to manage your appointments. Only one calendar can be active at a time.
        </p>
      </div>

      {!isCheckingBackendConfig && !isLoadingIntegrations && backendConfigError && configuredProviders.length > 0 && (
         <div className="p-4 mb-4 text-sm text-yellow-800 bg-yellow-50 rounded-lg border border-yellow-200" role="alert">
           <div className="flex items-center">
             <Info className="inline w-5 h-5 mr-2 text-yellow-600"/>
             <span className="font-semibold">Configuration Notice:</span>
           </div>
           <p className="ml-7">{backendConfigError}</p>
         </div>
      )}

      {isCheckingBackendConfig || isLoadingIntegrations ? (
        <div className="flex justify-center items-center h-64">
          <Loader2 className="h-8 w-8 animate-spin text-hero-blue mr-3" />
          Loading connections…
        </div>
      ) : integrationsError ? ( 
        <div className="p-6 bg-red-50 border border-red-200 rounded-lg">
            <div className="flex items-center">
                <AlertCircle className="h-5 w-5 text-red-500 mr-2" />
                <span className="text-lg font-semibold text-red-700">Error Loading Connections</span>
            </div>
            <p className="mt-2 text-red-600">{(integrationsError as Error).message}</p>
            <p className="mt-1 text-sm text-red-500">Please try refreshing the page. If the problem persists, contact support.</p>
        </div>
      ) : (
        (() => {
          const hasActiveIntegration = integrations.length > 0;
          const activeIntegration = hasActiveIntegration ? integrations[0] : null;

          if (hasActiveIntegration && activeIntegration) {
            return (
              <div className="p-6 border rounded-lg shadow-sm bg-white">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <h2 className="text-xl font-semibold text-gray-800">Active Calendar Integration</h2>
                    <div className="flex items-center mt-2">
                      <CheckCircle2 className="h-6 w-6 text-primary mr-2" />
                      <div>
                          <p className="font-medium text-gray-700">{activeIntegration.account_email}</p>
                          <Badge
                            variant={activeIntegration.status.startsWith("active") ? "default" : "secondary"}
                            className="text-xs"
                          >
                              {getProviderDisplayName(activeIntegration.provider)} - {activeIntegration.status.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase())}
                          </Badge>
                      </div>
                    </div>
                  </div>
                  <AlertDialog
                    open={selectedIntegrationId === activeIntegration.id}
                    onOpenChange={(open) => !open && setSelectedIntegrationId(null)}
                  >
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="destructive"
                        className="mt-4 sm:mt-0 w-full sm:w-auto"
                        onClick={() => setSelectedIntegrationId(activeIntegration.id)}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Disconnect Calendar
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Disconnect Calendar?</AlertDialogTitle>
                        <AlertDialogDescription>
                          Are you sure you want to disconnect your {getProviderDisplayName(activeIntegration.provider)} calendar ({activeIntegration.account_email})? This will stop all AI Employee activities related to this calendar. You can connect a new calendar afterwards.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-red-600 hover:bg-red-700 text-white"
                          onClick={() => disconnectCalendar.mutate(activeIntegration.id)}
                          disabled={disconnectCalendar.isPending}
                        >
                          {disconnectCalendar.isPending ? "Disconnecting..." : "Yes, Disconnect"}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </div>
            );
          } else {
            // No active integration, show options to connect (integrations.length is 0 here)
            return (
              <div>
                <h2 className="text-xl font-semibold text-gray-800 mb-1">Connect a Calendar Provider</h2>
                <p className="text-sm text-gray-500 mb-4">Choose one provider to manage your appointments.</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {(Object.keys(PROVIDER_CONFIGS) as CalendarProvider[]).map((providerKey) => {
                    const provider = PROVIDER_CONFIGS[providerKey];
                    const isProviderConfigured = configuredProviders.includes(provider.checkKey);
                    const isGoogleProvider = providerKey === "google";

                    let buttonDisabled = connectCalendar.isPending; // Base disabled state
                    let badgeMessage = "";
                    let currentBadgeClassName = "mt-1 text-xs";
                    let reasonMessage = "";
                    let reasonMessageClassName = "text-xs mt-2 text-center";

                    if (isGoogleProvider) {
                      const isCurrentUserAllowedForGoogle = !!(user?.email && ALLOWED_GOOGLE_CALENDAR_USERS.includes(user.email));
                      
                      console.log("--- Google Calendar Button State ---");
                      console.log("User Email:", user?.email);
                      console.log("Is User Allowed for Google:", isCurrentUserAllowedForGoogle);
                      console.log("Allowed Emails:", ALLOWED_GOOGLE_CALENDAR_USERS);
                      console.log("Is Google Backend Configured:", isProviderConfigured);
                      console.log("Is Connect Mutation Pending:", connectCalendar.isPending);

                      if (!isCurrentUserAllowedForGoogle) {
                        buttonDisabled = true;
                        badgeMessage = "Limited Access";
                        currentBadgeClassName += " text-yellow-600 border-yellow-300 bg-yellow-50";
                        reasonMessage = "Google Calendar integration is currently available for select users only.";
                        reasonMessageClassName += " text-orange-500";
                      } else { // Current user IS allowed for Google
                        if (!isProviderConfigured) {
                          buttonDisabled = true;
                          badgeMessage = "Admin setup needed";
                          currentBadgeClassName += " text-orange-600 border-orange-300 bg-orange-50";
                          reasonMessage = "Connection unavailable until backend is configured for Google Calendar.";
                          reasonMessageClassName += " text-orange-500";
                        }
                      }
                       console.log("Final Button Disabled State for Google:", buttonDisabled);
                       console.log("------------------------------------");
                    } else { // For other providers (Acuity, Calendly, Square)
                      if (!isProviderConfigured) {
                        buttonDisabled = true;
                        badgeMessage = "Admin setup needed";
                        currentBadgeClassName += " text-orange-600 border-orange-300 bg-orange-50";
                        reasonMessage = `Connection unavailable until backend is configured for ${provider.name}.`;
                        reasonMessageClassName += " text-red-500";
                      }
                    }

                    return (
                      <div key={providerKey} className={`p-5 border rounded-lg flex flex-col justify-between ${buttonDisabled ? 'bg-gray-50 opacity-70' : 'bg-white hover:shadow-md transition-shadow'}`}>
                        <div>
                          <div className="flex items-center space-x-2">
                            {provider.icon}
                            <h3 className="text-lg font-semibold text-gray-700">{provider.name}</h3>
                          </div>
                          {badgeMessage && (
                            <Badge variant="outline" className={currentBadgeClassName}>
                              {badgeMessage}
                            </Badge>
                          )}
                          <p className={`text-sm mt-1 mb-4 ${buttonDisabled ? 'text-gray-400' : 'text-gray-500'}`}>
                            {`Allow access to your ${provider.name} to automate appointment management.`}
                          </p>
                        </div>
                        <Button
                          onClick={() => connectCalendar.mutate(providerKey)}
                          disabled={buttonDisabled}
                          className="w-full"
                        >
                          <Calendar className="mr-2 h-4 w-4" />
                          {connectCalendar.isPending && connectCalendar.variables === providerKey
                            ? "Connecting…"
                            : `Connect ${provider.name}`}
                        </Button>
                         {reasonMessage && (
                           <p className={reasonMessageClassName}>{reasonMessage}</p>
                         )}
                      </div>
                    );
                  })}
                </div>
                 {integrations.length === 0 && ( 
                   <div className="text-center py-12 border-dashed border-2 border-gray-300 rounded-lg text-gray-500 mt-8 bg-gray-50">
                     <LinkIcon className="mx-auto mb-3 h-10 w-10 opacity-40" />
                     <p className="font-medium">No calendar connected yet.</p>
                     <p className="text-sm">Select an option above to get started.</p>
                   </div>
                 )}
              </div>
            );
          }
        })() 
      )}
    </div>
  );
}