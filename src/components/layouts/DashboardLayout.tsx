// src/components/layouts/DashboardLayout.tsx
import { Outlet } from 'react-router-dom';
import Sidebar from '@/components/navigation/Sidebar';
// import FeaturebaseWidget from '@/components/featurebase/FeaturebaseWidget'; // <<<--- REMOVE THIS LINE
import { Toaster } from '@/components/ui/sonner'; 

export default function DashboardLayout() {
  return (
    <div className="flex h-screen bg-muted"> 
      <Sidebar />
      {/* <FeaturebaseWidget /> // <<<--- REMOVE THIS LINE */}
      <main className="flex-1 overflow-y-auto bg-background p-4 md:p-6 lg:p-8">
        <Outlet />
      </main>
      <Toaster richColors position="top-right" /> 
    </div>
  );
}