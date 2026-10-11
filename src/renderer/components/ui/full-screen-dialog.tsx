import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '../../lib/utils';
import {
  DIALOG_DESCRIPTION_CLASS,
  DIALOG_OVERLAY_CLASS,
  DIALOG_TITLE_CLASS
} from './dialog-styles';

const FullScreenDialog = DialogPrimitive.Root;
const FullScreenDialogPortal = DialogPrimitive.Portal;
const FullScreenDialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(DIALOG_OVERLAY_CLASS, className)}
    {...props}
  />
));
FullScreenDialogOverlay.displayName = 'FullScreenDialogOverlay';

const FullScreenDialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(DIALOG_TITLE_CLASS, className)}
    {...props}
  />
));
FullScreenDialogTitle.displayName = 'FullScreenDialogTitle';

const FullScreenDialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn(DIALOG_DESCRIPTION_CLASS, className)}
    {...props}
  />
));
FullScreenDialogDescription.displayName = 'FullScreenDialogDescription';

export {
  FullScreenDialog,
  FullScreenDialogPortal,
  FullScreenDialogOverlay,
  FullScreenDialogTitle,
  FullScreenDialogDescription
};
