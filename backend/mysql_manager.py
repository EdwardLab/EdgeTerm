from __future__ import annotations

import base64
import datetime as dt
import decimal
import re
import time
from typing import Any

import pymysql
from pymysql.constants import CLIENT
from pymysql.cursors import DictCursor


IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9_$-]+$")
MAX_RESULT_ROWS = 1000


def quote_identifier(value: str) -> str:
    identifier = str(value or "").strip()
    if not identifier or not IDENTIFIER_PATTERN.fullmatch(identifier):
        raise ValueError(f"Invalid MySQL identifier: {identifier}")
    return f"`{identifier.replace('`', '``')}`"


def encode_value(value: Any) -> Any:
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, decimal.Decimal):
        return str(value)
    if isinstance(value, (dt.date, dt.datetime, dt.time)):
        return value.isoformat(sep=" ") if isinstance(value, dt.datetime) else value.isoformat()
    if isinstance(value, dt.timedelta):
        return str(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        data = bytes(value)
        return {
            "type": "blob",
            "bytes": len(data),
            "base64": base64.b64encode(data[:256]).decode("ascii"),
        }
    return str(value)


def connection_options(payload: dict[str, Any]) -> dict[str, Any]:
    source = payload.get("connection") if isinstance(payload.get("connection"), dict) else {}
    host = str(source.get("host") or "127.0.0.1").strip()
    user = str(source.get("user") or "root").strip()
    if not host or not user:
        raise ValueError("MySQL host and user are required.")
    try:
        port = int(source.get("port") or 3306)
    except (TypeError, ValueError) as exc:
        raise ValueError("MySQL port must be a number.") from exc
    if port < 1 or port > 65535:
        raise ValueError("MySQL port must be between 1 and 65535.")
    database = str(source.get("database") or "").strip()
    options = {
        "host": host,
        "port": port,
        "user": user,
        "password": str(source.get("password") or ""),
        "charset": "utf8mb4",
        "cursorclass": DictCursor,
        "autocommit": False,
        "connect_timeout": 8,
        "read_timeout": 30,
        "write_timeout": 30,
        "client_flag": CLIENT.MULTI_STATEMENTS,
    }
    if database:
        options["database"] = database
    return options


def rows_result(cursor, rows, duration_ms: float, **extra) -> dict[str, Any]:
    columns = [item[0] for item in (cursor.description or [])]
    encoded_rows = [[encode_value(row.get(column)) for column in columns] for row in rows]
    return {
        "columns": columns,
        "rows": encoded_rows,
        "durationMs": round(duration_ms, 2),
        **extra,
    }


def query_result(connection, statement: str, started: float) -> dict[str, Any]:
    if not statement.strip():
        raise ValueError("Enter a SQL statement first.")
    result_sets = []
    total_changes = 0
    with connection.cursor() as cursor:
        cursor.execute(statement)
        while True:
            if cursor.description:
                rows = cursor.fetchmany(MAX_RESULT_ROWS + 1)
                truncated = len(rows) > MAX_RESULT_ROWS
                rows = rows[:MAX_RESULT_ROWS]
                result_sets.append(rows_result(cursor, rows, 0, truncated=truncated, changes=0))
            else:
                changes = max(0, int(cursor.rowcount or 0))
                total_changes += changes
                result_sets.append({"columns": [], "rows": [], "changes": changes, "truncated": False})
            if not cursor.nextset():
                break
    connection.commit()
    duration_ms = (time.perf_counter() - started) * 1000
    final_result = result_sets[-1] if result_sets else {"columns": [], "rows": [], "changes": 0}
    final_result["durationMs"] = round(duration_ms, 2)
    final_result["changes"] = total_changes
    final_result["resultSetCount"] = len(result_sets)
    return final_result


def schema_result(connection, database: str, started: float) -> dict[str, Any]:
    if not database:
        raise ValueError("Select a MySQL database first.")
    statement = """
        SELECT TABLE_NAME AS name, LOWER(TABLE_TYPE) AS type, ENGINE AS engine,
               TABLE_ROWS AS estimatedRows,
               COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS sizeBytes,
               TABLE_COLLATION AS collation
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = %s
        ORDER BY TABLE_TYPE, TABLE_NAME
    """
    with connection.cursor() as cursor:
        cursor.execute(statement, (database,))
        rows = cursor.fetchall()
    duration_ms = (time.perf_counter() - started) * 1000
    schema = [{key: encode_value(value) for key, value in row.items()} for row in rows]
    columns = ["name", "type", "engine", "estimatedRows", "sizeBytes", "collation"]
    return {
        "schema": schema,
        "columns": columns,
        "rows": [[item.get(column) for column in columns] for item in schema],
        "durationMs": round(duration_ms, 2),
        "changes": 0,
    }


def structure_result(connection, table: str, started: float) -> dict[str, Any]:
    quoted = quote_identifier(table)
    with connection.cursor() as cursor:
        cursor.execute(f"SHOW FULL COLUMNS FROM {quoted}")
        columns = cursor.fetchall()
        cursor.execute(f"SHOW INDEX FROM {quoted}")
        indexes = cursor.fetchall()
        cursor.execute(f"SHOW CREATE TABLE {quoted}")
        create_row = cursor.fetchone() or {}
    duration_ms = (time.perf_counter() - started) * 1000
    normalized = [{key: encode_value(value) for key, value in row.items()} for row in columns]
    names = list(normalized[0].keys()) if normalized else []
    return {
        "columns": names,
        "rows": [[row.get(name) for name in names] for row in normalized],
        "structure": normalized,
        "indexes": [{key: encode_value(value) for key, value in row.items()} for row in indexes],
        "createSql": next((str(value) for key, value in create_row.items() if key.lower().startswith("create ")), ""),
        "durationMs": round(duration_ms, 2),
        "changes": 0,
    }


def browse_result(connection, table: str, limit: int, offset: int, started: float) -> dict[str, Any]:
    quoted = quote_identifier(table)
    limit = max(1, min(int(limit or 100), 500))
    offset = max(0, int(offset or 0))
    with connection.cursor() as cursor:
        cursor.execute(f"SELECT COUNT(*) AS total FROM {quoted}")
        total = int((cursor.fetchone() or {}).get("total") or 0)
        cursor.execute(f"SELECT * FROM {quoted} LIMIT %s OFFSET %s", (limit, offset))
        rows = cursor.fetchall()
        result = rows_result(cursor, rows, (time.perf_counter() - started) * 1000)
    result.update({"total": total, "limit": limit, "offset": offset, "table": table, "changes": 0})
    return result


def status_result(connection, started: float) -> dict[str, Any]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT VERSION() AS version, DATABASE() AS databaseName, USER() AS userName, "
            "@@hostname AS serverName, @@port AS port, @@character_set_server AS characterSet, "
            "@@collation_server AS collation"
        )
        row = cursor.fetchone() or {}
        cursor.execute("SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected', 'Uptime', 'Questions')")
        metrics = {item["Variable_name"]: encode_value(item["Value"]) for item in cursor.fetchall()}
    values = {**{key: encode_value(value) for key, value in row.items()}, **metrics}
    return {
        "columns": ["property", "value"],
        "rows": [[key, value] for key, value in values.items()],
        "status": values,
        "durationMs": round((time.perf_counter() - started) * 1000, 2),
        "changes": 0,
    }


def export_database(connection, database: str, started: float) -> dict[str, Any]:
    if not database:
        raise ValueError("Select a MySQL database first.")
    database_identifier = quote_identifier(database)
    lines = [f"CREATE DATABASE IF NOT EXISTS {database_identifier};", f"USE {database_identifier};", ""]
    with connection.cursor() as cursor:
        cursor.execute("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'")
        table_rows = cursor.fetchall()
        table_names = [next(iter(row.values())) for row in table_rows]
        for table in table_names:
            quoted = quote_identifier(str(table))
            cursor.execute(f"SHOW CREATE TABLE {quoted}")
            create_row = cursor.fetchone() or {}
            create_sql = next((str(value) for key, value in create_row.items() if key.lower().startswith("create ")), "")
            lines.extend([f"DROP TABLE IF EXISTS {quoted};", f"{create_sql};", ""])
            cursor.execute(f"SELECT * FROM {quoted}")
            columns = [item[0] for item in (cursor.description or [])]
            while True:
                rows = cursor.fetchmany(250)
                if not rows:
                    break
                values = []
                for row in rows:
                    encoded = []
                    for column in columns:
                        value = row.get(column)
                        if value is None:
                            encoded.append("NULL")
                        elif isinstance(value, (bytes, bytearray, memoryview)):
                            encoded.append(f"X'{bytes(value).hex()}'")
                        else:
                            encoded.append("'" + connection.escape_string(str(value)) + "'")
                    values.append("(" + ", ".join(encoded) + ")")
                column_sql = ", ".join(quote_identifier(column) for column in columns)
                lines.append(f"INSERT INTO {quoted} ({column_sql}) VALUES\n" + ",\n".join(values) + ";")
            lines.append("")
    return {
        "sql": "\n".join(lines),
        "fileName": f"{database}.sql",
        "tableCount": len(table_names),
        "durationMs": round((time.perf_counter() - started) * 1000, 2),
    }


def handle_mysql_action(payload: dict[str, Any]) -> dict[str, Any]:
    action = str(payload.get("action") or "test").strip().lower()
    options = connection_options(payload)
    database = str(options.get("database") or "")
    started = time.perf_counter()
    connection = pymysql.connect(**options)
    try:
        if action == "test":
            return status_result(connection, started)
        if action == "databases":
            with connection.cursor() as cursor:
                cursor.execute("SHOW DATABASES")
                rows = cursor.fetchall()
                names = [str(next(iter(row.values()))) for row in rows]
            return {"databases": names, "durationMs": round((time.perf_counter() - started) * 1000, 2)}
        if action == "schema":
            return schema_result(connection, database, started)
        if action == "structure":
            return structure_result(connection, str(payload.get("table") or ""), started)
        if action == "browse":
            return browse_result(connection, str(payload.get("table") or ""), payload.get("limit", 100), payload.get("offset", 0), started)
        if action == "status":
            return status_result(connection, started)
        if action == "export":
            return export_database(connection, database, started)
        if action == "query":
            return query_result(connection, str(payload.get("query") or ""), started)
        raise ValueError(f"Unsupported MySQL action: {action}")
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()
