import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonMenuButton, IonSpinner, IonToolbar } from '@ionic/angular/standalone';
import { environment } from '../../../../../environments/environment';

interface BankRow { id: number; transaction_date: string; amount: number; description: string; reference: string; status: string; currency_code: string; invoice_id?: number; }
interface Suggestion { invoice_id: number; document_number: string; customer_name: string; balance_due: string; reason: string; }
interface Preview { valid: boolean; rows: { line: number; data: Record<string,string>; errors: string[]; duplicate?: { id:number;status:string } }[]; }
interface InvoiceResult { data: { id:number; document_number:string; customer_name:string; total:number; currency_code:string }[]; }

@Component({
  selector: 'app-bank-review', standalone: true,
  imports: [CommonModule, IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonMenuButton, IonSpinner, IonToolbar],
  templateUrl: './bank-review.page.html', styleUrls: ['./bank-review.page.scss']
})
export class BankReviewPage implements OnInit {
  csv = '';
  fileName = '';
  preview: Preview | null = null;
  rows: BankRow[] = [];
  selected: BankRow | null = null;
  suggestions: Suggestion[] = [];
  invoiceResults: InvoiceResult['data'] = [];
  search = '';
  status: 'PENDING' | 'MATCHED' | 'IGNORED' = 'PENDING';
  busy = false;
  error = '';
  message = '';
  private api = environment.apiUrl;

  constructor(private http: HttpClient) {}
  ngOnInit() { this.loadRows(); }

  downloadTemplate() {
    const url=URL.createObjectURL(new Blob(['date,amount,currency,description,reference,transaction_id,account\r\n'],{type:'text/csv;charset=utf-8'}));
    const link=document.createElement('a'); link.href=url; link.download='freevoices-bank-template.csv'; link.click();
    setTimeout(()=>URL.revokeObjectURL(url),0);
  }
  async chooseFile(event: Event) {
    const file=(event.target as HTMLInputElement).files?.[0];
    this.preview=null; this.csv=''; this.error=''; this.message='';
    if (!file) return;
    if (file.size>500_000) { this.error='Choose a CSV smaller than 500 KB.'; return; }
    this.fileName=file.name; this.csv=await file.text(); this.previewFile();
  }
  previewFile() {
    if (!this.csv) return;
    this.busy=true;
    this.http.post<Preview>(`${this.api}/bank-imports/preview`,{csv:this.csv}).subscribe({
      next:preview=>{this.preview=preview;this.busy=false;},
      error:err=>{this.error=err.error?.message || 'Could not preview bank CSV.';this.busy=false;}
    });
  }
  commit() {
    if (!this.preview?.valid || this.busy) return;
    this.busy=true;
    this.http.post<{created:number;duplicates:number}>(`${this.api}/bank-imports/commit`,{csv:this.csv}).subscribe({
      next:result=>{this.busy=false;this.message=`${result.created} new transactions imported; ${result.duplicates} duplicates skipped.`;this.preview=null;this.loadRows();},
      error:err=>{this.busy=false;this.error=err.error?.message || 'Bank import failed.';}
    });
  }
  changeStatus(event: Event) { this.status=(event.target as HTMLSelectElement).value as typeof this.status; this.selected=null; this.loadRows(); }
  loadRows() {
    this.http.get<BankRow[]>(`${this.api}/bank-imports?status=${this.status}`).subscribe({
      next:rows=>this.rows=rows,
      error:err=>this.error=err.error?.message || 'Could not load bank transactions.'
    });
  }
  review(row: BankRow) {
    this.selected=row; this.suggestions=[]; this.invoiceResults=[]; this.search=''; this.error='';
    if (row.status!=='PENDING' || Number(row.amount)<=0) return;
    this.http.get<Suggestion[]>(`${this.api}/bank-imports/${row.id}/suggestions`).subscribe({
      next:items=>this.suggestions=items,
      error:err=>this.error=err.error?.message || 'Could not load match suggestions.'
    });
  }
  findInvoice() {
    if (!this.search.trim()) return;
    this.http.get<InvoiceResult>(`${this.api}/invoices?search=${encodeURIComponent(this.search.trim())}&limit=20`).subscribe({
      next:result=>this.invoiceResults=result.data,
      error:()=>this.error='Could not search invoices.'
    });
  }
  match(invoiceId: number) {
    if (!this.selected || this.busy) return;
    if (!window.confirm('Record this bank deposit as a payment against the selected invoice?')) return;
    this.busy=true;
    this.http.post<{message:string}>(`${this.api}/bank-imports/${this.selected.id}/match`,{invoice_id:invoiceId}).subscribe({
      next:result=>{this.busy=false;this.message=result.message;this.selected=null;this.loadRows();},
      error:err=>{this.busy=false;this.error=err.error?.message || 'Could not match payment.';}
    });
  }
  ignore() {
    if (!this.selected || !window.confirm('Ignore this bank transaction?')) return;
    this.http.post(`${this.api}/bank-imports/${this.selected.id}/ignore`,{}).subscribe({
      next:()=>{this.message='Transaction ignored.';this.selected=null;this.loadRows();},
      error:err=>this.error=err.error?.message || 'Could not ignore transaction.'
    });
  }
}
