import { FolderOpen, FolderPlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button';

interface WelcomeScreenProps {
  onNewProject: () => void;
  onOpenProject: () => void;
}

export function WelcomeScreen({ onNewProject, onOpenProject }: WelcomeScreenProps) {
  const { t } = useTranslation(['welcome']);

  return (
    <div className="flex h-full items-center justify-center p-8">
      <div className="w-full max-w-2xl">
        {/* Hero Section */}
        <div className="text-center mb-10">
          <h1 className="text-3xl font-bold text-foreground tracking-tight">
            {t('welcome:hero.title')}
          </h1>
          <p className="mt-3 text-muted-foreground">
            {t('welcome:hero.subtitle')}
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-4 justify-center">
          <Button
            size="lg"
            onClick={onNewProject}
            className="gap-2 px-6"
          >
            <FolderPlus className="h-5 w-5" />
            {t('welcome:actions.newProject')}
          </Button>
          <Button
            size="lg"
            variant="secondary"
            onClick={onOpenProject}
            className="gap-2 px-6"
          >
            <FolderOpen className="h-5 w-5" />
            {t('welcome:actions.openProject')}
          </Button>
        </div>
      </div>
    </div>
  );
}
