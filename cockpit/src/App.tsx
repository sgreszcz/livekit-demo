import { useRoute } from './router';
import { HomeView } from './views/HomeView';
import { DashboardView } from './views/DashboardView';
import { DebriefView } from './views/DebriefView';

export function App() {
  const route = useRoute();
  if (route.kind === 'debrief') return <DebriefView id={route.id} />;
  if (route.kind === 'dashboard') return <DashboardView />;
  return <HomeView />;
}
