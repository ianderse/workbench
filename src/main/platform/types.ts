/**
 * Platform Abstraction Types
 *
 * Defines the contract for platform-specific operations.
 * All platform differences should be expressed through these types.
 */

/**
 * Supported operating systems
 */
export enum OS {
  Windows = 'win32',
  macOS = 'darwin',
  Linux = 'linux'
}

