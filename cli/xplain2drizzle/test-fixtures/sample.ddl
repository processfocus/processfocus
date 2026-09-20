# Sample Xplain DDL for testing

base name (A64).
base email (A255).
base description (T).
base active (B).
base created at (D).
base quantity (I5).
base price (R10,2).
base arn (U).

type customer = name, email, optional description, active.
type product = name, description, unit_price.
type invoice = customer, created at.
type invoice line = invoice, product, quantity, unit_price.

index customer its idx1 = name.
unique index customer its email_idx = email.
index invoice line its line_idx = invoice, product.

default invoice its created at = system_date.
default product its unit_price = 0.
