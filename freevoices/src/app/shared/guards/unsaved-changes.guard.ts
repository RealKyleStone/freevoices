import { inject } from '@angular/core';
import { CanDeactivateFn } from '@angular/router';
import { AuthService } from '../../core/auth/services/auth.service';
import { AlertController } from '@ionic/angular/standalone';

/**
 * Implemented by create/edit pages. Return true while the form holds input
 * that has not been saved.
 */
export interface HasUnsavedChanges {
  hasUnsavedChanges(): boolean;
  discardUnsavedChanges?(): void;
}

/**
 * Ask before leaving a form with unsaved input. Navigating away used to
 * discard a half-written invoice without a word.
 *
 * This covers in-app navigation (back button, side menu, links). Closing or
 * reloading the tab is handled by each page's beforeunload listener, since the
 * browser does not let a page show its own dialog there.
 */
export const unsavedChangesGuard: CanDeactivateFn<HasUnsavedChanges> = async (component) => {
  // A logout or expired session must be able to leave a private cached page.
  if (!inject(AuthService).getCurrentUser()) return true;
  if (!component?.hasUnsavedChanges?.()) return true;

  const alertCtrl = inject(AlertController);
  const alert = await alertCtrl.create({
    header: 'Discard changes?',
    message: 'You have unsaved changes on this page. If you leave now they will be lost.',
    buttons: [
      { text: 'Keep editing', role: 'cancel' },
      { text: 'Discard', role: 'destructive' },
    ],
  });
  await alert.present();
  const { role } = await alert.onDidDismiss();
  if (role === 'destructive') component.discardUnsavedChanges?.();
  return role === 'destructive';
};
