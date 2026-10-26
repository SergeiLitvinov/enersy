param(
    [string]$Container = 'hybrid-db',
    [string]$Database = 'app_db',
    [string]$User = 'app_user',
    [string]$Schema = 'public',
    [string]$OutputFile
)
. (Join-Path $PSScriptRoot 'DockerTools.ps1')
Assert-DatabaseName $Database
$schemaLiteral = $Schema.Replace("'", "''")
$metadataSQL = @"
SELECT json_build_object(
 'schemaExists',EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='$schemaLiteral'),
 'relations',COALESCE(json_agg(json_build_object('name',c.relname,'kind',c.relkind) ORDER BY c.relname COLLATE "C"),'[]'::json))
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='$schemaLiteral' AND c.relkind IN ('r','p','S');
"@
$metadata = (Invoke-DatabaseDocker -Arguments @('exec', $Container, 'psql', '-X', '-qAt', '-U', $User, '-d', $Database, '-v', 'ON_ERROR_STOP=1', '-c', $metadataSQL)) -join "`n"
$metadataValue = $metadata | ConvertFrom-Json
if (-not $metadataValue.schemaExists) { throw 'Fingerprint schema does not exist.' }
$relations = @($metadataValue.relations)
$parts = @(foreach ($relation in $relations) {
    # Names come from PostgreSQL metadata; quote identifiers and SQL literals
    # separately. No source rows or credential hashes leave the database.
    $qualified = '"' + $Schema.Replace('"', '""') + '"."' + $relation.name.Replace('"', '""') + '"'
    $nameLiteral = $relation.name.Replace("'", "''")
    $kind = if ($relation.kind -ceq 'S') { 'sequence' } else { 'table' }
    $source = if ($kind -eq 'sequence') { "(SELECT last_value,is_called FROM $qualified)" } else { $qualified }
    @"
SELECT '$nameLiteral'::text AS name,'$kind'::text AS kind,count(*) AS rows,
 encode(sha256(convert_to(COALESCE(string_agg(row_sha,'' ORDER BY row_sha COLLATE "C"),''),'UTF8')),'hex') AS sha256
 FROM (SELECT encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') AS row_sha FROM $source t) row_hashes
"@
})
$recordSQL = if ($parts.Count) { 'SELECT COALESCE(json_agg(record ORDER BY record.name COLLATE "C"),''[]''::json) FROM (' + ($parts -join "`nUNION ALL`n") + ') record' } else { "SELECT '[]'::json" }
$sql = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='1s'; SET LOCAL TIME ZONE 'UTC'; SET LOCAL DateStyle='ISO, MDY'; $recordSQL; COMMIT;"
$recordsJSON = (Invoke-DatabaseDocker -Arguments @('exec', $Container, 'psql', '-X', '-qAt', '-U', $User, '-d', $Database, '-v', 'ON_ERROR_STOP=1', '-c', $sql)) -join "`n"
$records = @($recordsJSON | ConvertFrom-Json)
if ($records.Count -ne $relations.Count) { throw 'Incomplete data fingerprint.' }
$report = [ordered]@{
    formatVersion = 1
    schema = $Schema
    capturedUtc = [DateTime]::UtcNow.ToString('o')
    records = $records
} | ConvertTo-Json -Depth 8
if ($OutputFile) {
    [IO.File]::WriteAllText([IO.Path]::GetFullPath($OutputFile), $report, [Text.UTF8Encoding]::new($false))
}
return $report
