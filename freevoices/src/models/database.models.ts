// Base interface for common fields
interface BaseModel {
  id: number;
  created_at: string;
  updated_at?: string;
}

export interface User extends BaseModel {
  email: string;
  password_hash?: string;
  company_name: string;
  company_registration?: string;
  vat_number?: string;
  contact_person: string;
  phone: string;
  address: string;
  bank_name?: string;
  bank_account_number?: string;
  bank_branch_code?: string;
  bank_account_type?: string;
  email_verified: boolean;
  email_verification_token?: string;
  email_verification_expires?: string;
  failed_login_attempts: number;
  last_failed_attempt?: string;
}

export interface Currency extends BaseModel {
  code: string;
  name: string;
  symbol: string;
  is_active: boolean;
}

export interface Customer extends BaseModel {
  user_id: number;
  name: string;
  email: string;
  phone: string;
  vat_number?: string;
  billing_address: string;
  shipping_address?: string;
  payment_terms?: number;
  notes?: string;
}

export interface Document extends BaseModel {
  user_id: number;
  customer_id: number;
  type: 'invoice' | 'quote';
  document_number: string;
  currency_id: number;
  status: 'draft' | 'sent' | 'viewed' | 'paid' | 'cancelled';
  issue_date: string;
  due_date: string;
  valid_until?: string;
  payment_terms: number;
  subtotal: number;
  vat_amount: number;
  total: number;
  notes?: string;
  terms_conditions?: string;
}

export interface DocumentItem extends BaseModel {
  document_id: number;
  product_id?: number;
  description: string;
  quantity: number;
  unit_price: number;
  vat_rate: number;
  vat_amount: number;
  subtotal: number;
  total: number;
}

export interface DocumentTracking extends BaseModel {
  document_id: number;
  event_type: 'sent' | 'viewed' | 'paid';
  event_date: string;
  ip_address?: string;
  user_agent?: string;
}

export interface EmailLog extends BaseModel {
  document_id: number;
  recipient_email: string;
  subject: string;
  email_type: 'invoice' | 'quote' | 'reminder';
  status: 'sent' | 'failed';
  error_message?: string;
  sent_at?: string;
}

export interface Payment extends BaseModel {
  document_id: number;
  amount: number;
  payment_date: string;
  payment_method: 'bank_transfer' | 'cash' | 'card' | 'other';
  transaction_reference?: string;
  notes?: string;
}

export interface Product extends BaseModel {
  user_id: number;
  name: string;
  description?: string;
  price: number;
  vat_inclusive: boolean;
  is_active: boolean;
}

export interface Session extends BaseModel {
  userId: number;
  token: string;
  expires: string;
}

export interface Settings extends BaseModel {
  user_id: number;
  setting_key: string;
  setting_value: string;
}

export interface Bank extends BaseModel {
  name: string;
  swift_code: string;
  universal_branch_code: string;
  is_active: boolean;
}

export interface ApiResponse<T> {
  data?: T;
  error?: string;
  message?: string;
  status: number;
}