import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { IonButton, IonSpinner } from '@ionic/angular/standalone';
import { environment } from '../../../../../environments/environment';

interface Preview {
  kind: 'customers' | 'products';
  hash: string;
  valid: boolean;
  replayed?: boolean;
  previous_count?: number;
  rows: { line: number; data: Record<string, string>; errors: string[] }[];
}

@Component({
  selector: 'app-import-settings',
  standalone: true,
  imports: [CommonModule, IonButton, IonSpinner],
  templateUrl: './import-settings.page.html',
  styleUrls: ['./import-settings.page.scss']
})
export class ImportSettingsPage {
  kind: 'customers' | 'products' = 'customers';
  csv = '';
  fileName = '';
  preview: Preview | null = null;
  busy = false;
  error = '';
  result = '';
  private api = environment.apiUrl;

  constructor(private http: HttpClient) {}

  chooseKind(event: Event) {
    this.kind = (event.target as HTMLSelectElement).value as typeof this.kind;
    this.csv = '';
    this.fileName = '';
    this.preview = null;
    this.result = '';
  }

  downloadTemplate() {
    const header = this.kind === 'customers' ? 'name,email,billing_address,phone,payment_terms' : 'name,price,description,vat_inclusive';
    const url = URL.createObjectURL(new Blob([header + '\r\n'], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `freevoices-${this.kind}-template.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async chooseFile(event: Event) {
    const file = (event.target as HTMLInputElement).files?.[0];
    this.csv = '';
    this.preview = null;
    this.result = '';
    if (!file) return;
    if (file.size > 500_000) { this.error = 'Choose a CSV smaller than 500 KB.'; return; }
    this.error = '';
    this.fileName = file.name;
    this.csv = await file.text();
    this.previewFile();
  }

  previewFile() {
    if (!this.csv || this.busy) return;
    this.busy = true;
    this.http.post<Preview>(`${this.api}/imports/preview`, { kind: this.kind, csv: this.csv }).subscribe({
      next: preview => { this.busy = false; this.preview = preview; },
      error: err => { this.busy = false; this.error = err.error?.message || 'Could not preview this CSV.'; }
    });
  }

  commit() {
    if (!this.preview?.valid || this.busy) return;
    this.busy = true;
    this.error = '';
    this.http.post<{ count: number; replayed: boolean }>(`${this.api}/imports/commit`, { kind: this.kind, csv: this.csv }).subscribe({
      next: result => { this.busy = false; this.result = result.replayed ? `This file was already imported (${result.count} rows).` : `${result.count} ${this.kind} imported.`; this.preview = null; },
      error: err => { this.busy = false; this.error = err.error?.message || 'Import failed. Review the file and try again.'; if (err.error?.errors) this.previewFile(); }
    });
  }
}
