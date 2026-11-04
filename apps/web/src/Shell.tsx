// Sidebar shell for every page that acts as a demo identity. Below 768px the sidebar is a sheet
// opened from the top bar.
import { Briefcase, CalendarClock, FileText, Inbox, Settings, User } from 'lucide-react';
import { useEffect } from 'react';
import { Link, Navigate, Outlet, useLocation } from 'react-router';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from './components/ui/sidebar';
import { SketchGrid } from './components/SketchGrid';
import { ThemeToggle } from './components/ThemeToggle';
import { useIdentity } from './identity';
import { Loading } from './ui';

export function Shell() {
  const { identity, refresh } = useIdentity();
  const { pathname } = useLocation();
  // Badge counts follow every page change, so actions on one page show up in the sidebar.
  useEffect(refresh, [pathname, refresh]);

  if (identity === undefined) {
    return (
      <div className="p-6">
        <Loading error={null} />
      </div>
    );
  }
  if (identity === null) return <Navigate to="/" replace />;

  const { identity: who, badges } = identity;
  const nav = [
    { to: '/matches', label: 'Matches', icon: Inbox, badge: 0 },
    ...(who.kind === 'employer'
      ? [{ to: '/postings', label: 'Job postings', icon: Briefcase, badge: 0 }]
      : []),
    { to: '/interviews', label: 'Interviews', icon: CalendarClock, badge: badges.interviews },
    { to: '/offers', label: 'Offers', icon: FileText, badge: badges.offers },
    { to: '/profile', label: 'Profile', icon: User, badge: 0 },
    { to: '/settings', label: 'Settings', icon: Settings, badge: 0 },
  ];

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="gap-3 px-4 pt-4">
          <div className="flex items-center justify-between gap-2">
            <Link to="/matches" className="text-lg font-semibold tracking-[-0.01em] text-slate-900">
              ClearHire
            </Link>
            {/* Pulled out by its padding so the icon lines up with the identity card's right edge. */}
            <ThemeToggle className="-mr-1.5" />
          </div>
          <div className="rounded-lg bg-white/70 px-3 py-2 ring-1 ring-slate-200">
            <p className="text-[11px] font-medium tracking-[0.02em] text-slate-500 uppercase">
              Demo identity · {who.kind === 'candidate' ? 'Job seeker' : 'Employer'}
            </p>
            <p className="truncate text-sm font-medium text-slate-900">{who.name}</p>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              {nav.map((item) => (
                <NavItem key={item.to} {...item} active={pathname.startsWith(item.to)} />
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="px-4 pb-4">
          <Link to="/" className="text-sm text-slate-600 hover:text-slate-900">
            Switch demo identity
          </Link>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <SketchGrid />
        <header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-slate-200/70 bg-white/70 px-3 backdrop-blur-xl backdrop-saturate-150 motion-reduce:backdrop-blur-none">
          <SidebarTrigger aria-label="Open navigation" />
          <span className="truncate text-sm text-slate-600">
            Demo identity: <span className="font-medium text-slate-900">{who.name}</span>
          </span>
        </header>
        <Outlet />
      </SidebarInset>
    </SidebarProvider>
  );
}

function NavItem({
  to,
  label,
  icon: Icon,
  badge,
  active,
}: {
  to: string;
  label: string;
  icon: typeof Inbox;
  badge: number;
  active: boolean;
}) {
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active}>
        <Link to={to} onClick={() => setOpenMobile(false)}>
          <Icon />
          <span>{label}</span>
        </Link>
      </SidebarMenuButton>
      {badge > 0 && (
        <SidebarMenuBadge aria-label={`${badge} waiting on you`}>{badge}</SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}
