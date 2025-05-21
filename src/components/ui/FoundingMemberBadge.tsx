// src/components/ui/FoundingMemberBadge.tsx
import React from 'react';
import { Badge } from '@/components/ui/badge'; // Your existing Badge component
import { cn } from '@/lib/utils';

interface FoundingMemberBadgeProps {
  className?: string;
}

const FoundingMemberBadge: React.FC<FoundingMemberBadgeProps> = ({ className }) => {
  return (
    <Badge
      variant="outline" // Using outline and then custom styling
      className={cn(
        "border-yellow-500 text-yellow-700 bg-yellow-50 hover:bg-yellow-100 dark:border-yellow-400 dark:text-yellow-600 dark:bg-yellow-900/20 dark:hover:bg-yellow-800/20 select-none",
        className
      )}
      title="Joined before June 1st, 2025"
    >
      🌟 Founding Member
    </Badge>
  );
};

export default FoundingMemberBadge;