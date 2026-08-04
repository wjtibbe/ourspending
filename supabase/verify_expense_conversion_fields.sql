-- OurSpending — expense conversion fields verification.
-- READ-ONLY except for temporary rows it creates and rolls back.
-- Everything runs inside a transaction that ends in ROLLBACK, so production
-- data is never modified. Paste into the Supabase SQL editor and run.
--
-- A clean run ends with: "EXPENSE CONVERSION FIELDS VERIFICATION PASSED".
--
-- Run AFTER supabase/expense_conversion_fields.sql.

begin;

-- ------------------------------------------------------------
-- 1. The new columns exist, are the right shape, and are optional.
-- ------------------------------------------------------------
do $$
declare
  v_count integer;
begin
  select count(*) into v_count
    from information_schema.columns
   where table_schema = 'public' and table_name = 'expenses'
     and column_name in (
       'merchant_amount', 'merchant_currency', 'had_currency_conversion',
       'amount_authority', 'source_provider', 'conversion_source'
     );
  if v_count <> 6 then
    raise exception 'expected 6 new columns on expenses, found %', v_count;
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'expenses'
       and column_name = 'had_currency_conversion' and is_nullable = 'YES'
  ) then
    raise exception 'had_currency_conversion should be NOT NULL (defaulted false)';
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'expenses'
       and column_name in ('merchant_amount', 'merchant_currency', 'amount_authority',
                            'source_provider', 'conversion_source')
       and is_nullable = 'NO'
  ) then
    raise exception 'the merchant/audit columns must stay nullable -- manual expenses never set them';
  end if;
end $$;

-- ------------------------------------------------------------
-- 2. A pre-existing (pre-migration-shaped) manual expense is unaffected.
-- ------------------------------------------------------------
do $$
declare
  v_hh uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_id uuid;
  v_had boolean;
  v_merchant_amt numeric;
begin
  insert into households (id, name, usd_per_eur, cop_per_eur)
  values (v_hh, 'verify-conv', 1.08, 4500);

  insert into expenses (household_id, amount_orig, currency, amount_eur, rate_used,
                         kind, payer, category, note, spent_on, created_by)
  values (v_hh, 12.34, 'EUR', 12.34, 1, 'shared', 0, 'other', 'Spotify', current_date, v_user)
  returning id into v_id;

  select had_currency_conversion, merchant_amount into v_had, v_merchant_amt
    from expenses where id = v_id;

  if v_had is distinct from false then
    raise exception 'a plain manual expense must default had_currency_conversion to false, got %', v_had;
  end if;
  if v_merchant_amt is not null then
    raise exception 'a plain manual expense must not have a merchant amount invented, got %', v_merchant_amt;
  end if;
end $$;

-- ------------------------------------------------------------
-- 3. A Wise-converted import stores both amounts and flags correctly.
-- ------------------------------------------------------------
do $$
declare
  v_hh uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_id uuid;
  v_row record;
begin
  insert into households (id, name, usd_per_eur, cop_per_eur)
  values (v_hh, 'verify-conv-2', 1.08, 4500);

  insert into expenses (household_id, amount_orig, currency, amount_eur, rate_used,
                         kind, payer, category, note, spent_on, created_by,
                         merchant_amount, merchant_currency, had_currency_conversion,
                         amount_authority, source_provider, conversion_source)
  values (v_hh, 19.76, 'EUR', 19.76, 1, 'shared', 0, 'other', 'Éxito Express', current_date, v_user,
          71362, 'COP', true,
          'deducted_balance_amount', 'wise', 'wise_email')
  returning id into v_id;

  select * into v_row from expenses where id = v_id;

  if v_row.amount_orig <> 19.76 or v_row.currency <> 'EUR' then
    raise exception 'the deducted EUR amount must remain the authoritative stored amount, got % %',
      v_row.amount_orig, v_row.currency;
  end if;
  if v_row.merchant_amount <> 71362 or v_row.merchant_currency <> 'COP' then
    raise exception 'the merchant COP amount must survive unchanged, got % %',
      v_row.merchant_amount, v_row.merchant_currency;
  end if;
  if v_row.had_currency_conversion is distinct from true then
    raise exception 'had_currency_conversion must be true for a real conversion';
  end if;
  if v_row.amount_authority <> 'deducted_balance_amount' then
    raise exception 'amount_authority must record the deducted amount as authoritative';
  end if;

  -- Simulate a later exchange-rate update on the household -- must not touch
  -- the stored expense at all.
  update households set cop_per_eur = 4700 where id = v_hh;

  select * into v_row from expenses where id = v_id;
  if v_row.amount_orig <> 19.76 or v_row.merchant_amount <> 71362 then
    raise exception 'a later rate update must never change a historical import''s stored amounts';
  end if;

  -- Exactly one expense per Wise message -- no second row was created.
  if (select count(*) from expenses where household_id = v_hh) <> 1 then
    raise exception 'one Wise email must create exactly one expense';
  end if;
end $$;

rollback;

select 'EXPENSE CONVERSION FIELDS VERIFICATION PASSED' as result;
