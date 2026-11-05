const TABLES = ['messages', 'webhook_events', 'message_state'];

export async function auditDatabase(db) {
  const issues = [];
  const { rows: [role] } = await db.query(`SELECT current_user AS name,
    rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolinherit, rolcanlogin
    FROM pg_catalog.pg_roles WHERE rolname = current_user`);
  if (!role || role.name !== 'linebot_app' || !role.rolcanlogin ||
      ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls', 'rolinherit'].some(k => role[k])) {
    issues.push('unsafe_role');
  }
  const { rows: memberships } = await db.query(`SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname <> current_user AND pg_catalog.pg_has_role(current_user, oid, 'MEMBER')`);
  if (memberships.length) issues.push('role_memberships');

  const { rows: tables } = await db.query(`SELECT c.relname, c.relrowsecurity,
      pg_catalog.pg_get_userbyid(c.relowner) = current_user AS owned,
      pg_catalog.has_table_privilege(c.oid, 'SELECT') AS can_select,
      pg_catalog.has_table_privilege(c.oid, 'INSERT') AS can_insert,
      pg_catalog.has_table_privilege(c.oid, 'UPDATE') AS can_update,
      pg_catalog.has_table_privilege(c.oid, 'DELETE') AS can_delete
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'linebot' AND c.relname = ANY($1::text[]) AND c.relkind = 'r'`, [TABLES]);
  for (const name of TABLES) {
    const table = tables.find(t => t.relname === name);
    if (!table || !table.relrowsecurity || table.owned || !table.can_select || !table.can_insert ||
        (name !== 'webhook_events' && !table.can_update) || (name === 'messages' && !table.can_delete)) {
      issues.push(`table_permissions:${name}`);
    }
  }
  const { rows: policies } = await db.query(`SELECT tablename FROM pg_catalog.pg_policies
    WHERE schemaname = 'linebot' AND cmd = 'ALL' AND 'linebot_app' = ANY(roles)
      AND qual = 'true' AND with_check = 'true'`);
  if (TABLES.some(name => !policies.some(p => p.tablename === name))) issues.push('missing_rls_policies');
  // Validate deployed columns, without selecting any chat rows.
  await db.query(`SELECT message_id, webhook_event_id, group_id, user_id, message_text,
    quoted_message_id, sent_at, received_at, edited_at, last_edit_event_id FROM linebot.messages WHERE false`);
  await db.query('SELECT message_id, group_id, unsent_at FROM linebot.message_state WHERE false');
  await db.query('SELECT webhook_event_id, received_at FROM linebot.webhook_events WHERE false');

  // PUBLIC grants and column grants still count even with NOINHERIT.
  // Catalog metadata only; this does not query any other application's rows.
  const { rows: externalTables } = await db.query(`SELECT n.nspname AS schema, c.relname AS object
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname <> 'linebot' AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      AND c.relkind IN ('r','p','v','m','f') AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
      AND (pg_catalog.has_table_privilege(c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        OR pg_catalog.has_any_column_privilege(c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'))`);
  if (externalTables.length) issues.push('external_table_privileges');
  const { rows: externalDefiners } = await db.query(`SELECT n.nspname AS schema, p.proname AS object
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname <> 'linebot' AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      AND p.prosecdef AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
      AND pg_catalog.has_function_privilege(p.oid, 'EXECUTE')`);
  if (externalDefiners.length) issues.push('external_security_definer');
  const { rows: writableSchemas } = await db.query(`SELECT nspname AS schema FROM pg_catalog.pg_namespace
    WHERE nspname NOT LIKE 'pg_%' AND nspname <> 'information_schema'
      AND pg_catalog.has_schema_privilege(oid, 'CREATE')`);
  if (writableSchemas.length) issues.push('schema_create_privileges');
  return { ok: issues.length === 0, issues,
    externalTables, externalDefiners, memberships, writableSchemas };
}
