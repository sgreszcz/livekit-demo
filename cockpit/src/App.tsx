import { useRoute } from './router';
import { HomeView } from './views/HomeView';
import { DebriefView } from './views/DebriefView';

export function App() {
  const route = useRoute();
  return route.kind === 'debrief' ? <DebriefView id={route.id} /> : <HomeView />;
}
