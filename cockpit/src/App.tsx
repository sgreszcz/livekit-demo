import { useRoute } from './router';
import { HomeView } from './views/HomeView';
import { DashboardView } from './views/DashboardView';
import { DebriefView } from './views/DebriefView';
import { LiveView } from './views/LiveView';

export function App() {
  const route = useRoute();
  if (route.kind === 'debrief') return <DebriefView id={route.id} />;
  if (route.kind === 'dashboard') return <DashboardView />;
  if (route.kind === 'live') return <LiveView room={route.room} />;
  return <HomeView />;
}
