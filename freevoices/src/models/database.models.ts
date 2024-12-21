export interface User {
    id: number;
    email: string;
    company_name?: string;
    company_registration?: string;
    vat_number?: string;
    contact_person?: string;
    phone?: string;
    address?: string;
    bank_name?: string;
    bank_account_number?: string;
    bank_branch_code?: string;
    bank_account_type?: string;
    created_at: string;
    updated_at: string;
  }
  
  export interface Settings {
    id: number;
    user_id: number;
    setting_key: string;
    setting_value: string;
    created_at: string;
    updated_at: string;
  }
  
  export interface Session {
    id: number;
    userId: number;
    token: string;
    expires: string;
    created_at: string;
  }
  
  export interface ApiResponse<T> {
    data?: T;
    error?: string;
    message?: string;
    status: number;
  }