// src/components/navigation/Sidebar.tsx
import { NavLink, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  Phone,
  Bot,
  Link as LinkIcon,
  User,
  LogOut,
  Mail,
  Map // Ensure Map icon is imported
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import FoundingMemberBadge from '@/components/ui/FoundingMemberBadge';

const navigation = [
  { name: 'Integrations', href: '/dashboard/integrations', icon: LinkIcon },
];

export default function Sidebar() {
  const { signOut, user, isFoundingMember, profile } = useAuth();
  const navigate = useNavigate();

  const handleLogoutClick = async () => {
    try {
      const { error } = await signOut();
      if (error) {
        throw error;
      }
      toast.success('Logged out successfully');
      navigate('/login', { replace: true });
    } catch (error: any) {
      toast.error(`Logout failed: ${error.message || 'Unknown error'}`);
      console.error('Logout error from sidebar:', error);
    }
  };

  const userDisplayName = profile?.full_name || user?.email;

  return (
    <div className="flex flex-col h-full w-64 bg-muted border-r border-border">
      <div className="flex items-center justify-center px-4 py-0 border-b border-border">
        <img
          src="https://i.imgur.com/VAuAJzp.png"
          alt="AI Employee Logo"
          className="h-40 w-auto"
        />
      </div>      

      <div className="px-4 py-4 border-t border-border space-y-2">
        {userDisplayName && (
          <div className="flex flex-col items-start mb-2">
            <span className="text-xs text-secondary-foreground flex items-center">
              <Mail className="w-3 h-3 mr-1.5" />
              {userDisplayName}
            </span>
            {isFoundingMember && (
              <div className="mt-1.5">
                <FoundingMemberBadge className="text-xs px-2 py-0.5" />
              </div>
            )}
          </div>
        )}
        <Button
          variant="ghost"
          className="w-full justify-start text-secondary-foreground hover:bg-accent"
          onClick={handleLogoutClick}
        >
          <LogOut className="mr-3 h-5 w-5" aria-hidden="true" />
          Logout
        </Button>
      </div>
    </div>
  );
}