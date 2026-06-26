import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup } from '@angular/forms';
import { IonicModule, ToastController, ActionSheetController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { businessOutline, imageOutline, trashOutline, cloudUploadOutline, cameraOutline, imagesOutline } from 'ionicons/icons';
import { SettingsService } from '../../services/settings.service';
import { environment } from '../../../../../environments/environment';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';

@Component({
  selector: 'app-company-settings',
  templateUrl: './company-settings.page.html',
  styleUrls: ['./company-settings.page.scss'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, IonicModule]
})
export class CompanySettingsPage implements OnInit {
  form!: FormGroup;
  isLoading = true;
  isSaving = false;
  isUploadingLogo = false;
  submitted = false;
  logoUrl: string | null = null;
  logoPreview: string | null = null;
  selectedFile: File | null = null;
  readonly maxLogoSize = 5 * 1024 * 1024; // 5 MB

  constructor(
    private fb: FormBuilder,
    private settingsService: SettingsService,
    private toastCtrl: ToastController,
    private actionSheetCtrl: ActionSheetController
  ) {
    addIcons({ businessOutline, imageOutline, trashOutline, cloudUploadOutline, cameraOutline, imagesOutline });
  }

  ngOnInit() {
    this.form = this.fb.group({
      company_name: [''],
      company_registration: [''],
      vat_number: [''],
      address: ['']
    });

    this.settingsService.getSettings().subscribe({
      next: (data) => {
        this.form.patchValue({
          company_name: data.company_name || '',
          company_registration: data.company_registration || '',
          vat_number: data.vat_number || '',
          address: data.address || ''
        });
        if (data.company_logo) {
          this.logoUrl = `${this.getBaseUrl()}${data.company_logo}`;
        }
        this.isLoading = false;
      },
      error: () => {
        this.isLoading = false;
        this.showToast('Failed to load company settings', 'danger');
      }
    });
  }

  private getBaseUrl(): string {
    return environment.apiUrl.replace('/api', '');
  }

  // Called when user taps the logo upload area
  // On native Android/iOS: show action sheet with camera/gallery options
  // On web: fall through to the regular file input
  async onLogoTap() {
    if (!Capacitor.isNativePlatform()) {
      // On web, trigger the hidden file input
      document.getElementById('logoFileInput')?.click();
      return;
    }

    // On native — show action sheet with camera and gallery options
    const actionSheet = await this.actionSheetCtrl.create({
      header: 'Select Logo',
      buttons: [
        {
          text: 'Take Photo',
          icon: 'camera-outline',
          handler: () => this.captureImage(CameraSource.Camera)
        },
        {
          text: 'Choose from Gallery',
          icon: 'images-outline',
          handler: () => this.captureImage(CameraSource.Photos)
        },
        {
          text: 'Cancel',
          role: 'cancel'
        }
      ]
    });
    await actionSheet.present();
  }

  // Use Capacitor Camera plugin to take a photo or pick from gallery
  private async captureImage(source: CameraSource) {
    try {
      const image = await Camera.getPhoto({
        quality: 90,
        allowEditing: false,
        resultType: CameraResultType.DataUrl, // returns base64 data URL
        source
      });

      if (!image.dataUrl) return;

      // Show preview immediately
      this.logoPreview = image.dataUrl;

      // Convert base64 data URL to a File object so we can reuse uploadLogo()
      const response = await fetch(image.dataUrl);
      const blob = await response.blob();
      this.selectedFile = new File([blob], `logo_${Date.now()}.jpg`, { type: 'image/jpeg' });

    } catch (error: any) {
      // User cancelled — don't show an error
      if (error?.message !== 'User cancelled photos app') {
        this.showToast('Failed to capture image', 'danger');
      }
    }
  }

  // Handles web file input selection
  onFileSelected(event: Event) {
    const input = event.target as HTMLInputElement;
    if (!input.files?.length) return;

    const file = input.files[0];

    if (file.size > this.maxLogoSize) {
      this.showToast('Logo must be 5 MB or smaller', 'danger');
      input.value = '';
      return;
    }

    if (!file.type.startsWith('image/')) {
      this.showToast('Please select an image file (JPEG, PNG, GIF, WebP)', 'danger');
      input.value = '';
      return;
    }

    this.selectedFile = file;

    const reader = new FileReader();
    reader.onload = (e) => {
      this.logoPreview = e.target?.result as string;
    };
    reader.readAsDataURL(file);
  }

  uploadLogo() {
    if (!this.selectedFile) return;

    this.isUploadingLogo = true;
    this.settingsService.uploadLogo(this.selectedFile).subscribe({
      next: (res) => {
        this.isUploadingLogo = false;
        this.logoUrl = `${this.getBaseUrl()}${res.logo_url}`;
        this.logoPreview = null;
        this.selectedFile = null;
        this.showToast('Logo uploaded successfully', 'success');
      },
      error: (err) => {
        this.isUploadingLogo = false;
        this.showToast(err.error?.message || 'Failed to upload logo', 'danger');
      }
    });
  }

  removeLogo() {
    this.settingsService.deleteLogo().subscribe({
      next: () => {
        this.logoUrl = null;
        this.logoPreview = null;
        this.selectedFile = null;
        this.showToast('Logo removed', 'success');
      },
      error: () => this.showToast('Failed to remove logo', 'danger')
    });
  }

  cancelLogoSelection() {
    this.logoPreview = null;
    this.selectedFile = null;
  }

  isInvalid(field: string): boolean {
    const ctrl = this.form.get(field);
    return !!ctrl && ctrl.invalid && (ctrl.dirty || ctrl.touched || this.submitted);
  }

  onSubmit() {
    this.submitted = true;
    if (this.form.invalid) return;

    this.isSaving = true;
    this.settingsService.updateCompany(this.form.value).subscribe({
      next: () => {
        this.isSaving = false;
        this.submitted = false;
        this.form.markAsPristine();
        this.showToast('Company details saved', 'success');
      },
      error: (err) => {
        this.isSaving = false;
        this.showToast(err.error?.message || 'Failed to save company details', 'danger');
      }
    });
  }

  private async showToast(message: string, color: string) {
    const toast = await this.toastCtrl.create({ message, duration: 3000, color, position: 'bottom' });
    await toast.present();
  }
}