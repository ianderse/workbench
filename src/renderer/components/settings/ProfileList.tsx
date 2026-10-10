/**
 * ProfileList - API profiles (Accounts page)
 *
 * Anthropic-compatible endpoints (base URL + API key) that Claude Code can use instead of a
 * Claude subscription. The profile in use takes over from Claude accounts until switched back.
 */
import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, buttonVariants } from '../ui/button';
import { useSettingsStore } from '../../stores/settings-store';
import { ProfileEditDialog } from './ProfileEditDialog';
import { SettingsRow } from './SettingsRow';
import { maskApiKey } from '../../lib/profile-utils';
import { useToast } from '../../hooks/use-toast';
import type { APIProfile } from '@shared/types/profile';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog';

interface ProfileListProps {
  /** Optional callback when a profile is saved */
  onProfileSaved?: () => void;
}

const getHostFromUrl = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function ProfileList({ onProfileSaved }: ProfileListProps) {
  const { t } = useTranslation();
  const {
    profiles,
    activeProfileId,
    deleteProfile,
    setActiveProfile,
    profilesError
  } = useSettingsStore();

  const { toast } = useToast();

  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [editProfile, setEditProfile] = useState<APIProfile | null>(null);
  const [deleteConfirmProfile, setDeleteConfirmProfile] = useState<APIProfile | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isSettingActive, setIsSettingActive] = useState(false);

  const handleDeleteProfile = async () => {
    if (!deleteConfirmProfile) return;

    setIsDeleting(true);
    const success = await deleteProfile(deleteConfirmProfile.id);
    setIsDeleting(false);

    if (success) {
      toast({
        title: t('settings:apiProfiles.toast.delete.title'),
        description: t('settings:apiProfiles.toast.delete.description', {
          name: deleteConfirmProfile.name
        }),
      });
      setDeleteConfirmProfile(null);
      onProfileSaved?.();
    } else {
      toast({
        variant: 'destructive',
        title: t('settings:apiProfiles.toast.delete.errorTitle'),
        description: profilesError || t('settings:apiProfiles.toast.delete.errorFallback'),
      });
    }
  };

  /**
   * Use a profile, or go back to Claude accounts (null)
   */
  const handleSetActiveProfile = async (profileId: string | null) => {
    if (profileId !== null && profileId === activeProfileId) return;

    setIsSettingActive(true);
    const success = await setActiveProfile(profileId);
    setIsSettingActive(false);

    if (success) {
      if (profileId === null) {
        toast({
          title: t('settings:apiProfiles.toast.switch.oauthTitle'),
          description: t('settings:apiProfiles.toast.switch.oauthDescription'),
        });
      } else {
        const activeProfile = profiles.find(p => p.id === profileId);
        if (activeProfile) {
          toast({
            title: t('settings:apiProfiles.toast.switch.profileTitle'),
            description: t('settings:apiProfiles.toast.switch.profileDescription', {
              name: activeProfile.name
            }),
          });
        }
      }
      onProfileSaved?.();
    } else {
      toast({
        variant: 'destructive',
        title: t('settings:apiProfiles.toast.switch.errorTitle'),
        description: profilesError || t('settings:apiProfiles.toast.switch.errorFallback'),
      });
    }
  };

  return (
    <>
      {profiles.map((profile) => {
        const isActive = activeProfileId === profile.id;
        const customModels = profile.models ? Object.keys(profile.models).filter((k) => profile.models?.[k as keyof typeof profile.models]) : [];
        return (
          <SettingsRow
            key={profile.id}
            className="group"
            label={
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="truncate">{profile.name}</span>
                {isActive && (
                  <span className="shrink-0 text-(--nav-label-color)">{t('settings:apiProfiles.activeBadge')}</span>
                )}
              </span>
            }
            description={
              <span className="block truncate" title={profile.baseUrl}>
                {[
                  getHostFromUrl(profile.baseUrl),
                  maskApiKey(profile.apiKey),
                  customModels.length > 0
                    ? t('settings:apiProfiles.customModels', { models: customModels.join(', ') })
                    : null
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            }
          >
            <div className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setEditProfile(profile)}
                className="h-8 w-8 text-muted-foreground"
                title={t('settings:apiProfiles.tooltips.edit')}
                aria-label={t('settings:apiProfiles.tooltips.edit')}
              >
                <Pencil className="h-4 w-4" strokeWidth={1.75} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setDeleteConfirmProfile(profile)}
                disabled={isActive}
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                data-testid={`profile-delete-button-${profile.id}`}
                title={
                  isActive
                    ? t('settings:apiProfiles.tooltips.deleteActive')
                    : t('settings:apiProfiles.tooltips.deleteInactive')
                }
                aria-label={t('settings:apiProfiles.deleteAriaLabel', { name: profile.name })}
              >
                <Trash2 className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            </div>
            {isActive ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSetActiveProfile(null)}
                disabled={isSettingActive}
              >
                {isSettingActive
                  ? t('settings:apiProfiles.switchToOauth.loading')
                  : t('settings:apiProfiles.switchToOauth.label')}
              </Button>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleSetActiveProfile(profile.id)}
                disabled={isSettingActive}
              >
                {isSettingActive
                  ? t('settings:apiProfiles.setActive.loading')
                  : t('settings:apiProfiles.setActive.label')}
              </Button>
            )}
          </SettingsRow>
        );
      })}
      <SettingsRow
        label={t('settings:apiProfiles.addButton')}
        description={profiles.length === 0 ? t('settings:apiProfiles.empty.description') : t('settings:apiProfiles.description')}
      >
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setIsAddDialogOpen(true)}>
          <Plus className="h-4 w-4" strokeWidth={1.75} />
          {t('settings:apiProfiles.add')}
        </Button>
      </SettingsRow>

      {/* Add/Edit Dialog */}
      <ProfileEditDialog
        open={isAddDialogOpen || editProfile !== null}
        onOpenChange={(open) => {
          if (!open) {
            setIsAddDialogOpen(false);
            setEditProfile(null);
          }
        }}
        onSaved={() => {
          setIsAddDialogOpen(false);
          setEditProfile(null);
          onProfileSaved?.();
        }}
        profile={editProfile ?? undefined}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={deleteConfirmProfile !== null}
        onOpenChange={() => setDeleteConfirmProfile(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('settings:apiProfiles.dialog.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('settings:apiProfiles.dialog.deleteDescription', {
                name: deleteConfirmProfile?.name ?? ''
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t('settings:apiProfiles.dialog.cancel')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteProfile}
              disabled={isDeleting}
              className={buttonVariants({ variant: 'destructive', size: 'sm' })}
            >
              {isDeleting
                ? t('settings:apiProfiles.dialog.deleting')
                : t('settings:apiProfiles.dialog.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
