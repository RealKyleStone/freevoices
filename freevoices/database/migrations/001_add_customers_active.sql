-- Migration: add soft-delete support to customers table
-- Run this when you are ready to enable soft-delete on customer records.
-- After running this, update the DELETE /api/customers/:id endpoint in server.js
-- to use: UPDATE customers SET active = false WHERE id = ? AND user_id = ?
-- and add AND active = true to the SELECT / UPDATE queries.

ALTER TABLE `customers`
  ADD COLUMN `active` TINYINT(1) NOT NULL DEFAULT 1 AFTER `notes`;
