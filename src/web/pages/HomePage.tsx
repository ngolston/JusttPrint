import { LayoutDashboard, Library } from 'lucide-react';
import { Button } from '../components/Button';
import { EmptyState, Panel } from '../components/Panel';
import { navigate } from '../shell/routes';

/** Home until the dashboard is built (Phase 5 of docs/redesign-5.md). */
export function HomePage() {
  return (
    <div className="jp-page__inner">
      <Panel>
        <EmptyState icon={LayoutDashboard} title="The dashboard is on its way"
          action={<Button variant="primary" icon={Library} onClick={() => navigate('library')}>Open the Library</Button>}>
          Library figures, recent activity and your printers will appear here.
        </EmptyState>
      </Panel>
    </div>
  );
}
