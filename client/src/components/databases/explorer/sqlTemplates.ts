import type { DbFamily, DbxObjectKind } from '@oblimint/shared';

/**
 * Starting points of the console for the objects of a database. MySQL /
 * MariaDB: views and routines in SQL SECURITY INVOKER — the console's
 * temporary SQL user would otherwise be their DEFINER, and they would stop
 * working once that user is dropped (triggers and events always run as their
 * definer: the comment says so).
 */
export type TemplateId = 'select' | 'insert' | 'update' | 'delete' | DbxObjectKind;

export function sqlTemplate(family: DbFamily, id: TemplateId, table = 'my_table'): string {
  const t = family === 'mysql' ? `\`${table.replace(/`/g, '``')}\`` : /^[a-z_][a-z0-9_]*$/.test(table) ? table : `"${table.replace(/"/g, '""')}"`;
  const definerNote = '-- MySQL / MariaDB: a trigger or an event runs as its DEFINER, here the temporary SQL user of this session:\n-- it stops working when the session ends. Create it from the site (migration) or a permanent user instead.\n';
  switch (id) {
    case 'select': return `SELECT *\nFROM ${t}\nWHERE 1 = 1\nLIMIT 100;`;
    case 'insert': return `INSERT INTO ${t} (column1, column2)\nVALUES ('value1', 'value2');`;
    case 'update': return `UPDATE ${t}\nSET column1 = 'value'\nWHERE id = 1;`;
    case 'delete': return `DELETE FROM ${t}\nWHERE id = 1;`;
    case 'view':
      return family === 'mysql'
        ? `CREATE OR REPLACE SQL SECURITY INVOKER VIEW my_view AS\nSELECT *\nFROM ${t};`
        : `CREATE OR REPLACE VIEW my_view AS\nSELECT *\nFROM ${t};`;
    case 'procedure':
      return family === 'mysql'
        ? 'DELIMITER $$\nCREATE PROCEDURE my_procedure(IN p_id INT)\nSQL SECURITY INVOKER\nBEGIN\n  SELECT p_id;\nEND$$\nDELIMITER ;'
        : 'CREATE OR REPLACE PROCEDURE my_procedure(p_id integer)\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RAISE NOTICE \'%\', p_id;\nEND;\n$$;';
    case 'function':
      return family === 'mysql'
        ? 'DELIMITER $$\nCREATE FUNCTION my_function(p INT) RETURNS INT\nDETERMINISTIC\nSQL SECURITY INVOKER\nBEGIN\n  RETURN p + 1;\nEND$$\nDELIMITER ;'
        : 'CREATE OR REPLACE FUNCTION my_function(p integer) RETURNS integer\nLANGUAGE sql IMMUTABLE\nAS $$\n  SELECT p + 1\n$$;';
    case 'trigger':
      return family === 'mysql'
        ? `${definerNote}DELIMITER $$\nCREATE TRIGGER my_trigger BEFORE INSERT ON ${t}\nFOR EACH ROW\nBEGIN\n  -- SET NEW.column1 = UPPER(NEW.column1);\nEND$$\nDELIMITER ;`
        : `CREATE OR REPLACE FUNCTION my_trigger_fn() RETURNS trigger\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  -- NEW.column1 := upper(NEW.column1);\n  RETURN NEW;\nEND;\n$$;\n\nCREATE TRIGGER my_trigger BEFORE INSERT ON ${t}\nFOR EACH ROW EXECUTE FUNCTION my_trigger_fn();`;
    case 'event':
      return `${definerNote}CREATE EVENT my_event\nON SCHEDULE EVERY 1 DAY\nDO\n  DELETE FROM ${t} WHERE created_at < NOW() - INTERVAL 30 DAY;`;
    default:
      return '';
  }
}
