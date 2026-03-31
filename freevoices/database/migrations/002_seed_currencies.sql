-- Migration: seed default currencies
-- The currencies table must have at least one row before invoices or quotes can be created.
-- currency_id = 1 (ZAR) is the default used by the application until multi-currency is implemented (Phase 3.3).

INSERT INTO `currencies` (`id`, `code`, `name`, `symbol`, `is_active`) VALUES
(1, 'ZAR', 'South African Rand', 'R',  1),
(2, 'USD', 'US Dollar',          '$',  1),
(3, 'EUR', 'Euro',               '€',  1),
(4, 'GBP', 'British Pound',      '£',  1);
