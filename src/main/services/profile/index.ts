/**
 * Profile Service - Barrel Export
 *
 * Re-exports all profile-related functionality for convenient importing.
 * Main process code should import from this index file.
 */

// Profile Manager utilities
export {
  loadProfilesFile,
  validateFilePermissions,
  getProfilesFilePath,
  atomicModifyProfiles
} from './profile-manager';

// Profile Service
export {
  createProfile,
  updateProfile,
  deleteProfile,
  getAPIProfileEnv,
  testConnection,
  discoverModels
} from './profile-service';

;

// Re-export types from shared for convenience
;
