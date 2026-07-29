-- Category-override isolation between households (rolls back).
begin;
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid();
  ha uuid; hb uuid; n int; blocked boolean; lbl text;
begin
  insert into auth.users (id, email, instance_id, aud, role) values
    (ua,'a@t.invalid','00000000-0000-0000-0000-000000000000','authenticated','authenticated'),
    (ub,'b@t.invalid','00000000-0000-0000-0000-000000000000','authenticated','authenticated');
  insert into households (name, invite_code) values ('A','codeaaaa') returning id into ha;
  insert into households (name, invite_code) values ('B','codebbbb') returning id into hb;
  perform set_config('app.household_assign','on',true);
  insert into profiles (id, display_name, household_id, slot) values (ua,'A',ha,0),(ub,'B',hb,0);
  perform set_config('app.household_assign','off',true);

  -- Household B renames a built-in for itself.
  insert into household_categories (household_id, category_key, is_custom, label, icon, active)
  values (hb,'groceries',false,'Supermarket','X',true);
  insert into household_categories (household_id, category_key, is_custom, label, icon, active)
  values (hb,'custom_secret',true,'Secret','Y',true);

  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims', json_build_object('sub',ua,'role','authenticated')::text, true);

  select count(*) into n from household_categories where household_id = hb;
  assert n = 0, 'LEAK: household A can read household B category overrides';

  -- A's own view is unaffected: it has no rows, so it still sees the defaults.
  select count(*) into n from household_categories where household_id = ha;
  assert n = 0, 'household A correctly has zero override rows (pure defaults)';

  blocked := false;
  begin
    update household_categories set label = 'Hacked' where household_id = hb;
    get diagnostics n = row_count;
    if n > 0 then raise exception 'LEAK: household A rewrote household B category labels'; end if;
    blocked := true;
  exception when insufficient_privilege then blocked := true;
  end;
  assert blocked, 'LEAK: cross-household category update succeeded';

  blocked := false;
  begin
    delete from household_categories where household_id = hb;
    get diagnostics n = row_count;
    if n > 0 then raise exception 'LEAK: household A deleted household B categories'; end if;
    blocked := true;
  exception when insufficient_privilege then blocked := true;
  end;
  assert blocked, 'LEAK: cross-household category delete succeeded';

  blocked := false;
  begin
    insert into household_categories (household_id, category_key, is_custom, label, icon, active)
    values (hb,'injected',true,'Injected','Z',true);
    raise exception 'LEAK: household A inserted a category into household B';
  exception when insufficient_privilege then blocked := true;
       when others then blocked := true;
  end;
  assert blocked, 'LEAK: cross-household category insert succeeded';

  -- A member may manage their OWN household's categories (no admin role).
  insert into household_categories (household_id, category_key, is_custom, label, icon, active)
  values (ha,'groceries',false,'Mercado','M',true);
  update household_categories set label = 'Mercadito' where household_id = ha and category_key='groceries';
  get diagnostics n = row_count;
  assert n = 1, 'BROKEN: a member cannot manage their own household categories';

  -- B still sees its own override, untouched by A.
  perform set_config('request.jwt.claims', json_build_object('sub',ub,'role','authenticated')::text, true);
  select label into lbl from household_categories where household_id = hb and category_key='groceries';
  assert lbl = 'Supermarket', format('BROKEN: household B override changed to %s', lbl);

  perform set_config('role','postgres',true);
  raise notice 'CATEGORY RLS VERIFICATION PASSED';
end $$;
rollback;
