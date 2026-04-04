SET SQL_MODE = "NO_AUTO_VALUE_ON_ZERO";

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;


CREATE TABLE banks (
  id int(11) NOT NULL,
  name varchar(100) NOT NULL,
  swift_code varchar(11) DEFAULT NULL,
  universal_branch_code varchar(6) DEFAULT NULL,
  is_active tinyint(1) DEFAULT 1,
  created_at timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

CREATE TABLE currencies (
  id bigint(20) NOT NULL,
  code varchar(3) NOT NULL,
  name varchar(50) NOT NULL,
  symbol varchar(5) NOT NULL,
  is_active tinyint(1) DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

CREATE TABLE customers (
  id bigint(20) NOT NULL,
  user_id bigint(20) NOT NULL,
  name varchar(255) NOT NULL,
  email varchar(255) DEFAULT NULL,
  phone varchar(50) DEFAULT NULL,
  vat_number varchar(100) DEFAULT NULL,
  billing_address text DEFAULT NULL,
  shipping_address text DEFAULT NULL,
  payment_terms int(11) DEFAULT NULL COMMENT 'Number of days, e.g., 30 for NET 30',
  notes text DEFAULT NULL,
  active tinyint(1) NOT NULL DEFAULT 1,
  created_at timestamp NOT NULL DEFAULT current_timestamp(),
  updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

CREATE TABLE documents (
  id bigint(20) NOT NULL,
  user_id bigint(20) NOT NULL,
  customer_id bigint(20) NOT NULL,
  type enum('INVOICE','QUOTE') NOT NULL,
  document_number varchar(50) NOT NULL,
  currency_id bigint(20) NOT NULL,
  status enum('DRAFT','SENT','PAID','OVERDUE','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  issue_date date NOT NULL,
  due_date date DEFAULT NULL,
  valid_until date DEFAULT NULL COMMENT 'For quotes - expiration date',
  payment_terms int(11) DEFAULT NULL COMMENT 'Number of days, inherited from customer if null',
  subtotal decimal(15,2) NOT NULL,
  vat_amount decimal(15,2) NOT NULL,
  total decimal(15,2) NOT NULL,
  notes text DEFAULT NULL,
  terms_conditions text DEFAULT NULL,
  created_at timestamp NOT NULL DEFAULT current_timestamp(),
  updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

CREATE TABLE document_items (
  id bigint(20) NOT NULL,
  document_id bigint(20) NOT NULL,
  product_id bigint(20) DEFAULT NULL,
  description text NOT NULL,
  quantity decimal(15,2) NOT NULL,
  unit_price decimal(15,2) NOT NULL,
  vat_rate decimal(5,2) NOT NULL DEFAULT 15.00,
  vat_amount decimal(15,2) NOT NULL,
  subtotal decimal(15,2) NOT NULL,
  total decimal(15,2) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

CREATE TABLE document_tracking (
  id bigint(20) NOT NULL,
  document_id bigint(20) NOT NULL,
  event_type enum('CREATED','SENT','VIEWED','DOWNLOADED','PAID','CANCELLED') NOT NULL,
  event_date timestamp NOT NULL DEFAULT current_timestamp(),
  ip_address varchar(45) DEFAULT NULL,
  user_agent text DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

CREATE TABLE email_log (
  id bigint(20) NOT NULL,
  document_id bigint(20) NOT NULL,
  recipient_email varchar(255) NOT NULL,
  subject varchar(255) NOT NULL,
  email_type enum('INVOICE','QUOTE','REMINDER','RECEIPT') NOT NULL,
  status enum('PENDING','SENT','FAILED') NOT NULL DEFAULT 'PENDING',
  error_message text DEFAULT NULL,
  sent_at timestamp NULL DEFAULT NULL,
  created_at timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

CREATE TABLE password_reset_tokens (
  id bigint(20) NOT NULL,
  user_id bigint(20) NOT NULL,
  token varchar(255) NOT NULL,
  expires_at timestamp NOT NULL,
  used tinyint(1) NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

CREATE TABLE payments (
  id bigint(20) NOT NULL,
  document_id bigint(20) NOT NULL,
  amount decimal(15,2) NOT NULL,
  payment_date date NOT NULL,
  payment_method enum('PAYFLEX','PAYFAST','CARDANO','BANK_TRANSFER','OTHER') NOT NULL,
  transaction_reference varchar(255) DEFAULT NULL,
  notes text DEFAULT NULL,
  created_at timestamp NOT NULL DEFAULT current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

CREATE TABLE products (
  id bigint(20) NOT NULL,
  user_id bigint(20) NOT NULL,
  name varchar(255) NOT NULL,
  description text DEFAULT NULL,
  price decimal(15,2) NOT NULL,
  vat_inclusive tinyint(1) DEFAULT 0,
  is_active tinyint(1) DEFAULT 1,
  created_at timestamp NOT NULL DEFAULT current_timestamp(),
  updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

CREATE TABLE sessions (
  id int(11) NOT NULL,
  userId int(11) NOT NULL,
  token varchar(255) NOT NULL,
  expires datetime NOT NULL,
  created_at timestamp NULL DEFAULT current_timestamp()
) ENGINE=MyISAM DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE settings (
  id bigint(20) NOT NULL,
  user_id bigint(20) NOT NULL,
  setting_key varchar(50) NOT NULL,
  setting_value text DEFAULT NULL,
  created_at timestamp NOT NULL DEFAULT current_timestamp(),
  updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;

CREATE TABLE users (
  id bigint(20) NOT NULL,
  email varchar(255) NOT NULL,
  password_hash varchar(255) NOT NULL,
  company_name varchar(255) DEFAULT NULL,
  company_registration varchar(100) DEFAULT NULL,
  vat_number varchar(100) DEFAULT NULL,
  contact_person varchar(255) DEFAULT NULL,
  phone varchar(50) DEFAULT NULL,
  address text DEFAULT NULL,
  bank_name varchar(255) DEFAULT NULL,
  bank_account_number varchar(100) DEFAULT NULL,
  bank_branch_code varchar(50) DEFAULT NULL,
  bank_account_type varchar(50) DEFAULT NULL,
  created_at timestamp NOT NULL DEFAULT current_timestamp(),
  updated_at timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  email_verified tinyint(1) DEFAULT 0,
  email_verification_token varchar(255) DEFAULT NULL,
  email_verification_expires timestamp NULL DEFAULT NULL,
  failed_login_attempts int(11) DEFAULT 0,
  last_failed_attempt datetime DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=latin1 COLLATE=latin1_swedish_ci;


ALTER TABLE banks
  ADD PRIMARY KEY (id);

ALTER TABLE currencies
  ADD PRIMARY KEY (id),
  ADD UNIQUE KEY code (code);

ALTER TABLE customers
  ADD PRIMARY KEY (id),
  ADD KEY user_id (user_id);

ALTER TABLE documents
  ADD PRIMARY KEY (id),
  ADD UNIQUE KEY user_id (user_id,type,document_number),
  ADD KEY customer_id (customer_id),
  ADD KEY currency_id (currency_id);

ALTER TABLE document_items
  ADD PRIMARY KEY (id),
  ADD KEY document_id (document_id),
  ADD KEY product_id (product_id);

ALTER TABLE document_tracking
  ADD PRIMARY KEY (id),
  ADD KEY document_id (document_id);

ALTER TABLE email_log
  ADD PRIMARY KEY (id),
  ADD KEY document_id (document_id);

ALTER TABLE password_reset_tokens
  ADD PRIMARY KEY (id),
  ADD UNIQUE KEY token (token),
  ADD KEY user_id (user_id);

ALTER TABLE payments
  ADD PRIMARY KEY (id),
  ADD KEY document_id (document_id);

ALTER TABLE products
  ADD PRIMARY KEY (id),
  ADD KEY user_id (user_id);

ALTER TABLE sessions
  ADD PRIMARY KEY (id),
  ADD KEY userId (userId);

ALTER TABLE settings
  ADD PRIMARY KEY (id),
  ADD UNIQUE KEY user_id (user_id,setting_key);

ALTER TABLE users
  ADD PRIMARY KEY (id),
  ADD UNIQUE KEY email (email);


ALTER TABLE banks
  MODIFY id int(11) NOT NULL AUTO_INCREMENT;

ALTER TABLE currencies
  MODIFY id bigint(20) NOT NULL AUTO_INCREMENT;

ALTER TABLE customers
  MODIFY id bigint(20) NOT NULL AUTO_INCREMENT;

ALTER TABLE documents
  MODIFY id bigint(20) NOT NULL AUTO_INCREMENT;

ALTER TABLE document_items
  MODIFY id bigint(20) NOT NULL AUTO_INCREMENT;

ALTER TABLE document_tracking
  MODIFY id bigint(20) NOT NULL AUTO_INCREMENT;

ALTER TABLE email_log
  MODIFY id bigint(20) NOT NULL AUTO_INCREMENT;

ALTER TABLE password_reset_tokens
  MODIFY id bigint(20) NOT NULL AUTO_INCREMENT;

ALTER TABLE payments
  MODIFY id bigint(20) NOT NULL AUTO_INCREMENT;

ALTER TABLE products
  MODIFY id bigint(20) NOT NULL AUTO_INCREMENT;

ALTER TABLE sessions
  MODIFY id int(11) NOT NULL AUTO_INCREMENT;

ALTER TABLE settings
  MODIFY id bigint(20) NOT NULL AUTO_INCREMENT;

ALTER TABLE users
  MODIFY id bigint(20) NOT NULL AUTO_INCREMENT;


ALTER TABLE customers
  ADD CONSTRAINT customers_ibfk_1 FOREIGN KEY (user_id) REFERENCES `users` (id);

ALTER TABLE documents
  ADD CONSTRAINT documents_ibfk_1 FOREIGN KEY (user_id) REFERENCES `users` (id),
  ADD CONSTRAINT documents_ibfk_2 FOREIGN KEY (customer_id) REFERENCES customers (id),
  ADD CONSTRAINT documents_ibfk_3 FOREIGN KEY (currency_id) REFERENCES currencies (id);

ALTER TABLE document_items
  ADD CONSTRAINT document_items_ibfk_1 FOREIGN KEY (document_id) REFERENCES documents (id),
  ADD CONSTRAINT document_items_ibfk_2 FOREIGN KEY (product_id) REFERENCES products (id);

ALTER TABLE document_tracking
  ADD CONSTRAINT document_tracking_ibfk_1 FOREIGN KEY (document_id) REFERENCES documents (id);

ALTER TABLE email_log
  ADD CONSTRAINT email_log_ibfk_1 FOREIGN KEY (document_id) REFERENCES documents (id);

ALTER TABLE password_reset_tokens
  ADD CONSTRAINT fk_prt_user FOREIGN KEY (user_id) REFERENCES `users` (id) ON DELETE CASCADE;

ALTER TABLE payments
  ADD CONSTRAINT payments_ibfk_1 FOREIGN KEY (document_id) REFERENCES documents (id);

ALTER TABLE products
  ADD CONSTRAINT products_ibfk_1 FOREIGN KEY (user_id) REFERENCES `users` (id);

ALTER TABLE settings
  ADD CONSTRAINT settings_ibfk_1 FOREIGN KEY (user_id) REFERENCES `users` (id);

/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
